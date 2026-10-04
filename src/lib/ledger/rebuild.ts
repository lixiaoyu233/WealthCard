/**
 * 从交易重建 Holding
 *
 * ## 单一真相来源
 *
 * 按确认的架构（方案 A）：
 *
 *   Transaction → deriveLedgerEffects → Ledger Effects
 *                                              ↓
 *                                        Holdings（可重建缓存）
 *                                              ↓  估值引擎
 *                                        Snapshot（估值快照）
 *
 * `Holding.quantity / costBasis / averageCost` **不再作为独立事实来源**，
 * 只是派生结果的**缓存**。缓存与交易不一致时，正确做法是
 * `rebuildHoldingsFromTransactions()`，**而不是**修改交易去迎合缓存。
 *
 * ## 安全规则：绝不静默删除资产
 *
 * 如果某个 `quantity` 口径持仓在交易里找不到对应记录（例如历史流水缺失、
 * 手工新增未记账、迁移不完整），重建时：
 *
 * - **保留该 Holding**
 * - 标记 `orphan: true`
 * - 产生 `OrphanHolding` 报告
 *
 * 由用户决定「补一条 adjustment 纳入账本」还是「明确删除」。
 * **绝不因为一次重建就悄悄丢掉用户的资产。**
 *
 * ## 与 manual 口径的关系
 *
 * `valuationMode === 'manual'` 的持仓（房产 / 应收 / 尚未确认分类的现金）
 * 由 `manualValue` 表达，不参与重建，原样保留。
 */

import type { Holding, Instrument, Portfolio2 } from '../../types/portfolio2'
import { type DerivedPosition, type LedgerReport, deriveLedger, positionKey } from './derive'
import { detectDuplicateHoldings } from './duplicates'

/** 孤立持仓：在交易里找不到依据，但持仓表里存在 */
export interface OrphanHolding {
  holdingId: string
  accountId: string
  instrumentId: string
  quantity: number
  costBasis: number
  /** 建议的处理方式说明 */
  suggestion: string
}

export interface RebuildResult {
  /** 重建后的全部持仓（含 manual 与孤立持仓） */
  holdings: Holding[]
  /** 从交易重建出来的持仓数 */
  rebuiltCount: number
  /** 原样保留的 manual 持仓数 */
  preservedCount: number
  /** 交易里有、但原持仓表中不存在的持仓（新建） */
  createdCount: number
  /** 原持仓表里有、但交易已把数量与成本归零的持仓 */
  emptiedCount: number
  /** **孤立持仓**：交易里没有依据，已保留并标记 */
  orphans: OrphanHolding[]
  /** 因缺少 Instrument 而无法重建的持仓键 */
  skipped: string[]
  /** 是否因重复持仓而被阻断（此时 holdings 原样返回，未做任何改动） */
  blocked?: boolean
  /** 被阻断时的重复详情 */
  duplicateReport?: import('./duplicates').DuplicateReport
}

const iso = (t?: number) => new Date(t ?? Date.now()).toISOString()
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/**
 * 现金类标的：数量即金额。
 *
 * `instrumentType === 'cash'`（明确录入为现金）或 `assetClass === 'cash'`（用户确认的类别）
 * 任一成立即可 —— 迁移数据的 instrumentType 只能是 'other'，必须靠 assetClass 兜底。
 */
function isCashInstrument(inst: Instrument | undefined): boolean {
  if (!inst) return false
  return inst.instrumentType === 'cash' || inst.assetClass === 'cash'
}

/**
 * 重建全部持仓。
 *
 * 规则：
 * - 交易派生出的持仓 → 覆盖 quantity / costBasis / averageCost（缓存刷新）；
 * - `manualValue` / `note` / `openedAt` / `id` 等**非派生字段原样保留**；
 * - 原表不存在但交易里有 → 新建；
 * - 交易里没有依据的 quantity 持仓 → **保留并标记 orphan**（不删除）；
 * - manual 口径持仓 → 原样保留。
 */
export function rebuildHoldingsFromTransactions(portfolio: Portfolio2): RebuildResult {
  /*
   * 入口先做重复检测。
   *
   * 为什么必须在这里阻断：重建以 `accountId::instrumentId` 为键，
   * 有重复时后者会覆盖前者，导致**静默丢失资产**。
   * 因此宁可不重建，也不能算错。
   */
  const dup = detectDuplicateHoldings(portfolio)
  if (!dup.ok) {
    return {
      holdings: portfolio.holdings,
      rebuiltCount: 0,
      preservedCount: 0,
      createdCount: 0,
      emptiedCount: 0,
      orphans: [],
      skipped: [],
      blocked: true,
      duplicateReport: dup,
    }
  }
  const ledger = deriveLedger(portfolio.transactions, ledgerOptionsFor(portfolio))
  return rebuildFromLedger(portfolio, ledger)
}

/** 重建时统一使用与迁移/转换一致的标的判定 */
/**
 * 派生时需要的标的查表函数。
 *
 * ## 为什么用 Map（Phase 8 / W9，P2-2）
 *
 * 原实现把两个查表都写成 `portfolio.instruments.find(...)`。这两个闭包会在
 * `deriveLedgerEffects` 里**逐笔交易**被调用（`derive.ts:243`、`:265-266`、`:289-291`），
 * 于是整体代价是 `O(T × I)` —— T=2,000 / I=2,000 时【估算】27.8ms，
 * 而一次性建 Map 只需 0.30ms（约 92×）。
 *
 * 语义完全不变：查不到仍返回 `undefined` / `false`。
 */
export function ledgerOptionsFor(portfolio: Portfolio2) {
  const instrumentById = new Map(portfolio.instruments.map((i) => [i.id, i]))
  return {
    instrumentCurrency: (id: string) => instrumentById.get(id)?.currency,
    isConfirmedCash: (id: string) => {
      const inst = instrumentById.get(id)
      return !!inst && inst.instrumentType === 'cash' && inst.classificationStatus === 'confirmed'
    },
  }
}

export function rebuildFromLedger(portfolio: Portfolio2, ledger: LedgerReport): RebuildResult {
  const instrumentById = new Map(portfolio.instruments.map((i) => [i.id, i]))
  const existingByKey = new Map(
    portfolio.holdings.map((h) => [positionKey(h.accountId, h.instrumentId), h]),
  )

  const holdings: Holding[] = []
  const skipped: string[] = []
  const orphans: OrphanHolding[] = []
  let rebuiltCount = 0
  let createdCount = 0
  let emptiedCount = 0

  /* ---- 1) manual 持仓原样保留（房产 / 应收 / 未确认分类的现金） ---- */
  for (const h of portfolio.holdings) {
    if (h.valuationMode === 'manual') holdings.push(h)
  }
  const preservedCount = holdings.length

  const timestamp = iso()

  /* ---- 2) 由交易派生重建 ---- */
  const derivedKeys = new Set<string>()
  for (const pos of ledger.positions.values()) {
    const key = positionKey(pos.accountId, pos.instrumentId)
    derivedKeys.add(key)

    const inst = instrumentById.get(pos.instrumentId)
    if (!inst) {
      skipped.push(key)
      continue
    }

    const existing = existingByKey.get(key)
    const isEmpty = Math.abs(pos.quantity) < 1e-8 && Math.abs(pos.costBasis) < 0.005
    if (isEmpty) emptiedCount += 1

    const base: Holding = existing ?? {
      id: `hold_rebuilt_${pos.accountId}_${pos.instrumentId}`,
      accountId: pos.accountId,
      instrumentId: pos.instrumentId,
      valuationMode: 'quantity',
      createdAt: pos.firstTransactionAt ?? timestamp,
      updatedAt: timestamp,
    }

    holdings.push({
      ...base,
      valuationMode: 'quantity',
      quantity: round8(pos.quantity),
      costBasis: round8(pos.costBasis),
      averageCost: isCashInstrument(inst) ? 1 : round8(pos.averageCost),
      openedAt: base.openedAt ?? pos.firstTransactionAt,
      // 找到依据即不再是孤立
      orphan: undefined,
      updatedAt: timestamp,
    })

    if (existing) rebuiltCount += 1
    else createdCount += 1
  }

  /* ---- 3) 孤立持仓：交易里没有依据，但持仓表里有 → 保留并标记 ---- */
  for (const h of portfolio.holdings) {
    if (h.valuationMode === 'manual') continue
    const key = positionKey(h.accountId, h.instrumentId)
    if (derivedKeys.has(key)) continue

    // 该持仓没有任何交易依据 → 视为孤立，保留原值
    const inst = instrumentById.get(h.instrumentId)
    const orphan: OrphanHolding = {
      holdingId: h.id,
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      quantity: h.quantity ?? 0,
      costBasis: h.costBasis ?? 0,
      suggestion: inst
        ? '交易流水里没有该持仓的依据：可补一条期初 adjustment 纳入账本，或明确删除该持仓'
        : '该持仓的标的已缺失：请先修复标的后再决定处理方式',
    }
    orphans.push(orphan)

    holdings.push({ ...h, orphan: true, updatedAt: timestamp })
  }

  return { holdings, rebuiltCount, preservedCount, createdCount, emptiedCount, orphans, skipped }
}

/** 便捷包装：直接返回可用于替换 Holding 表的数组 */
export function rebuildAllHoldingsFromTransactions(portfolio: Portfolio2): Holding[] {
  return rebuildHoldingsFromTransactions(portfolio).holdings
}

/**
 * 单点重建（用于编辑保存后刷新缓存）。
 * 找不到对应交易时返回原值，**不做破坏性改写**。
 */
export function rebuildHoldingFromTransactions(
  portfolio: Portfolio2,
  accountId: string,
  instrumentId: string,
): Holding | undefined {
  const ledger = deriveLedger(portfolio.transactions, ledgerOptionsFor(portfolio))
  const pos = ledger.positions.get(positionKey(accountId, instrumentId))

  const existing = portfolio.holdings.find(
    (h) => h.accountId === accountId && h.instrumentId === instrumentId,
  )

  // 没有交易依据：保持原样（manual 或孤立持仓都不动）
  if (!pos) return existing

  const instrument = portfolio.instruments.find((i) => i.id === instrumentId)
  const base: Holding = existing ?? {
    id: `hold_rebuilt_${accountId}_${instrumentId}`,
    accountId,
    instrumentId,
    valuationMode: 'quantity',
    createdAt: pos.firstTransactionAt ?? iso(),
    updatedAt: iso(),
  }

  return {
    ...base,
    valuationMode: 'quantity',
    quantity: round8(pos.quantity),
    costBasis: round8(pos.costBasis),
    averageCost: isCashInstrument(instrument) ? 1 : round8(pos.averageCost),
    openedAt: base.openedAt ?? pos.firstTransactionAt,
    orphan: undefined,
    updatedAt: iso(),
  }
}

/**
 * 把孤立持仓纳入账本：生成一条 `adjustment`，使交易能够解释该持仓。
 *
 * 这是「补期初余额」的稳妥做法 —— 不直接改 Holding，而是**留痕**。
 */
export function adoptOrphanHolding(
  portfolio: Portfolio2,
  holdingId: string,
  options: { timestamp?: string; note?: string } = {},
): { transaction: import('../../types/portfolio2').Transaction | null; reason?: string } {
  const h = portfolio.holdings.find((x) => x.id === holdingId)
  if (!h) return { transaction: null, reason: '找不到该持仓' }
  if (h.valuationMode !== 'quantity') return { transaction: null, reason: '只有数量口径持仓需要纳入账本' }

  const instrument = portfolio.instruments.find((i) => i.id === h.instrumentId)
  if (!instrument) return { transaction: null, reason: '该持仓的标的已缺失，请先修复' }

  // 若已有依据，则无需再补
  const ledger = deriveLedger(portfolio.transactions, ledgerOptionsFor(portfolio))
  if (ledger.positions.has(positionKey(h.accountId, h.instrumentId))) {
    return { transaction: null, reason: '该持仓已有交易依据，无需补期初' }
  }

  const timestamp = options.timestamp ?? iso()
  return {
    transaction: {
      id: `adj_adopt_${h.id}`,
      accountId: h.accountId,
      instrumentId: h.instrumentId,
      type: 'adjustment',
      quantity: h.quantity ?? 0,
      amount: h.costBasis ?? 0,
      currency: instrument.currency,
      timestamp,
      note: options.note ?? '补记期初余额：将孤立持仓纳入交易账本',
    },
  }
}

/** 派生位置 → 便于 UI 展示的摘要 */
export function describePosition(pos: DerivedPosition): string {
  return `数量 ${pos.quantity}，成本 ${pos.costBasis}，均价 ${pos.averageCost}`
}
