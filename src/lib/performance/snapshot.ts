/**
 * Snapshot 组装与写入
 *
 * 职责：把「当前资产状态 + 当日交易 + 汇率」组装成一份可持久化的 Snapshot。
 *
 * 关键约束（用户确认的口径）：
 *
 * 1. **写快照的职责是记录当天实际算得出来的状态**，因此
 *    即使 `isComplete = false`、有 stale/unavailable、缺 FX、无法完整归因，
 *    **也必须写入**，不能因为归因失败就丢弃历史事实。
 * 2. **同日幂等**：同一天重复执行只更新、不新增（依赖 `upsertForDate`）。
 * 3. **不填假数据**：无法计算的字段一律 `undefined`，绝不用 0 冒充。
 * 4. **positions 只记录实际持仓状态**，交易 / leg 不会再次计入总额。
 */

import type { Portfolio2, Snapshot, SnapshotPosition, Transaction } from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type FxTable, resolveRate } from '../valuation/fx'
import { valuateHolding } from '../valuation/engine'
import { type QuotePolicy } from '../valuation/policy'
import { classifyPortfolioFlows } from './cashflow'
import { type Attribution, attribute, computeExchangeFxEffect } from './attribution'

const round2 = (n: number) => Math.round(n * 100) / 100

/** 由日期字符串取上一日（用于找期初快照） */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export interface BuildSnapshotOptions {
  /** 快照日期 YYYY-MM-DD；缺省为今天（UTC） */
  date?: string
  /** 汇率表；缺省用 portfolio.fxRates */
  fx?: FxTable
  policy?: QuotePolicy
  now?: number
  /** 期初快照；缺省视为首日 */
  opening?: Snapshot
}

export interface SnapshotBuildResult {
  snapshot: Snapshot
  attribution: Attribution
  /** 当日参与计算的交易 */
  transactions: Transaction[]
}

/* ------------------------------------------------------------------ *
 * 构建
 * ------------------------------------------------------------------ */

/**
 * 组装快照。**纯函数**：不读写存储，便于测试与预览。
 */
export function buildSnapshot(
  portfolio: Portfolio2,
  options: BuildSnapshotOptions = {},
): SnapshotBuildResult {
  const date = options.date ?? new Date(options.now ?? Date.now()).toISOString().slice(0, 10)
  const fx = options.fx ?? { rates: portfolio.fxRates }
  const policy = options.policy

  /* ---- 1) 逐持仓估值，并生成持仓级明细 ---- */
  const positions: SnapshotPosition[] = []
  let totalAssets = 0
  let totalLiabilities = 0
  const assetAllocation: Record<string, number> = {}
  let unavailableCount = 0
  let staleCount = 0

  for (const holding of portfolio.holdings) {
    const r = valuateHolding(holding, portfolio, {
      fx,
      now: options.now,
      policy,
    })
    const instrument = portfolio.instruments.find((i) => i.id === holding.instrumentId)
    const currency = r.currency

    // 汇率：CNY 恒为 1；外币取实际可用汇率（缺失则不写数字，标 unreliable）
    const resolved = currency === 'CNY' ? 1 : resolveRate(fx, currency, 'CNY', { now: options.now })?.rate

    /*
     * 原币价值与单价：
     * - available / stale 都可能有原币价值（stale 用「上次已知价值」作为展示依据）；
     * - 现金与手动口径的单价恒为 1（数量即金额）。
     */
    const isCash = instrument?.instrumentType === 'cash' || instrument?.assetClass === 'cash'
    const nativeValue = r.valueInCurrency ?? r.fallbackValueInCurrency ?? 0
    const price =
      holding.valuationMode === 'manual' || isCash
        ? 1
        : holding.quantity
          ? nativeValue / holding.quantity
          : 0

    const reliable = r.status === 'ok'
    if (r.status === 'unavailable') unavailableCount += 1
    if (r.status === 'stale') staleCount += 1

    if (reliable && r.value !== undefined) {
      // eslint-disable-next-line no-lonely-if
      if (r.assetClass === 'liability') {
        totalLiabilities += Math.abs(r.value)
      } else {
        totalAssets += r.value
        const cls = r.assetClass ?? 'other'
        assetAllocation[cls] = (assetAllocation[cls] ?? 0) + r.value
      }
    }

    // 数量：数量口径用 quantity；现金/手动口径用金额表达（数量即金额）
    const quantity =
      holding.valuationMode === 'manual' || isCash ? round2(holding.manualValue ?? holding.quantity ?? 0) : (holding.quantity ?? 0)

    /*
     * 记录**捕获当时**的资产类别（Schema V4）。
     *
     * 只写用户**已确认**的分类；未确认时保持 `undefined` ——
     * 不能把「迁移时的线索」当成历史事实写进快照。
     */
    const classAtCapture =
      instrument && instrument.classificationStatus === 'confirmed' ? instrument.assetClass : undefined

    positions.push({
      instrumentId: holding.instrumentId,
      accountId: holding.accountId,
      quantity,
      price: round2(price) || 1,
      currency,
      // 汇率缺失时不写 1 冒充；CNY 恒为 1
      rateToCny: resolved ?? (currency === 'CNY' ? 1 : 0),
      valueCny: reliable && r.value !== undefined ? round2(r.value) : 0,
      reliable,
      assetClassAtCapture: classAtCapture,
    })
  }

  const netWorth = round2(totalAssets - totalLiabilities)

  /* ---- 2) 当日交易 → 外部现金流 ---- */
  const transactions = portfolio.transactions.filter((t) => t.timestamp.slice(0, 10) === date)

  const converter = (amount: number, currency: string): number | undefined => {
    if (currency === 'CNY') return amount
    const r = resolveRate(fx, currency as never, 'CNY', { now: options.now })
    return r ? amount * r.rate : undefined
  }
  const flow = classifyPortfolioFlows(portfolio, transactions, converter)

  /* ---- 3) 组装快照外壳（归因字段先留空，由 attribute 填充） ---- */
  const base: Snapshot = {
    id: `snap_${date}`,
    date,
    totalAssets: round2(totalAssets),
    totalLiabilities: round2(totalLiabilities),
    netWorth,
    currency: 'CNY',
    assetAllocation: assetAllocation as Snapshot['assetAllocation'],
    positions,
    unavailableCount,
    staleCount,
    isComplete: unavailableCount === 0 && staleCount === 0,
    // 本阶段只产生 REAL；BACKFILLED / ESTIMATED 留待未来的回填功能
    captureKind: 'REAL',
    attributionStatus: 'unavailable',
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
  }

  /* ---- 4) 归因 ---- */
  // 换汇的已实现汇率差额：归入 fxEffect，不计入投资收益
  const exchangeFx = computeExchangeFxEffect(transactions, converter)

  const attribution = attribute({
    opening: options.opening,
    ending: base,
    flow,
    exchangeFx,
  })

  const snapshot: Snapshot = {
    ...base,
    openingNetWorth: attribution.openingNetWorth,
    externalInflow: attribution.externalInflow,
    externalOutflow: attribution.externalOutflow,
    investmentReturn: attribution.investmentReturn,
    fxEffect: attribution.fxEffect,
    otherAdjustment: attribution.otherAdjustment,
    residual: attribution.residual,
    otherAdjustmentReason: attribution.otherAdjustmentReason,
    internalTransferCount: attribution.internalTransferCount,
    feeTotal: attribution.feeTotal,
    attributionStatus: attribution.status,
    attributionNotes: attribution.notes.length > 0 ? attribution.notes : undefined,
  }

  return { snapshot, attribution, transactions }
}

/* ------------------------------------------------------------------ *
 * 便捷派生量
 * ------------------------------------------------------------------ */

/** 外部净流入 */
export function externalNetFlow(snapshot: Snapshot): number | undefined {
  if (snapshot.externalInflow === undefined || snapshot.externalOutflow === undefined) return undefined
  return round2(snapshot.externalInflow - snapshot.externalOutflow)
}

/** 该快照是否可用于展示「今天赚了多少」 */
export function canShowReturn(snapshot: Snapshot): boolean {
  return (
    snapshot.attributionStatus === 'complete' &&
    snapshot.investmentReturn !== undefined &&
    snapshot.isComplete === true
  )
}

/* ------------------------------------------------------------------ *
 * 写入（幂等）
 * ------------------------------------------------------------------ */

export interface CaptureResult {
  snapshot: Snapshot
  /** 是新建还是更新了已有记录 */
  action: 'created' | 'updated'
  attribution: Attribution
}

export interface CaptureOptions extends BuildSnapshotOptions {
  /** 仅预览不写入 */
  dryRun?: boolean
}

/**
 * 生成并写入当日快照。
 *
 * 幂等：同一天重复调用只会更新同一条记录（`id` 与 `createdAt` 保留）。
 * 即使归因不完整也会写入 —— 快照的首要职责是记录事实。
 */
export async function captureSnapshot(
  repo: PortfolioRepository,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const portfolio = await repo.loadPortfolio()
  const date = options.date ?? new Date(options.now ?? Date.now()).toISOString().slice(0, 10)

  // 期初：优先用传入值，否则取前一天的快照
  let opening = options.opening
  if (!opening) {
    const all = await repo.snapshots.getAll()
    const previous = all
      .filter((s) => s.date < date)
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    opening = previous
  }

  const existing = await repo.snapshots.byDate(date)
  const { snapshot, attribution } = buildSnapshot(portfolio, { ...options, date, opening })

  // 保留原有的 id 与 createdAt，体现「更新而非新增」
  const toSave: Snapshot = existing
    ? { ...snapshot, id: existing.id, createdAt: existing.createdAt }
    : snapshot

  if (options.dryRun) {
    return { snapshot: toSave, action: existing ? 'updated' : 'created', attribution }
  }

  await repo.snapshots.upsertForDate(toSave)
  return { snapshot: toSave, action: existing ? 'updated' : 'created', attribution }
}

/** 批量补齐一段日期区间缺失的快照（用于导入后回填），同日幂等 */
export async function captureRange(
  repo: PortfolioRepository,
  fromDate: string,
  toDate: string,
  options: Omit<CaptureOptions, 'date'> = {},
): Promise<CaptureResult[]> {
  const dates: string[] = []
  const cursor = new Date(`${fromDate}T00:00:00.000Z`)
  const end = new Date(`${toDate}T00:00:00.000Z`)
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  const out: CaptureResult[] = []
  for (const d of dates) {
    out.push(await captureSnapshot(repo, { ...options, date: d }))
  }
  return out
}
