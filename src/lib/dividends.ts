/**
 * 分红数据：记录 + 偏好 + 抓取缓存，以及「入账」用的纯函数。
 *
 * 单独一个键存储（asset-card-wallet/dividends/v1），与持仓数据互不影响：
 * 分红属于辅助数据，这个键丢了最多重新抓一次，不会动到资产本身。
 */
import type { FundItem, Portfolio } from '../types/asset'
import type { CurrencyCode } from './currency'
import type { HoldingMarket } from './usStock'
import { safeNum } from './calc'
import { toCny, type FxRates } from './currency'

export const DIVIDENDS_STORAGE_KEY = 'asset-card-wallet/dividends/v1'

export type DividendFrequency = 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'irregular'
export type DividendMode = 'cash' | 'reinvest'

export const FREQUENCY_LABEL: Record<DividendFrequency, string> = {
  monthly: '每月',
  quarterly: '每季',
  semiannual: '每半年',
  annual: '每年',
  irregular: '不定期',
}

export interface DividendRecord {
  id: string
  code: string
  market: HoldingMarket
  name?: string
  /** 关联的持仓条目 id（手工录入时用来定位份额） */
  itemId?: string
  /** 除息日 YYYY-MM-DD（主日期） */
  exDate: string
  recordDate?: string
  payDate?: string
  declarationDate?: string
  /** 每份 / 每股税前派息（原币） */
  cashPerUnit: number
  /** 税后每份 / 每股派息（自动源公告里会直接给） */
  afterTaxPerUnit?: number
  /** 每 10 股送转合计（A股） */
  bonusRatio?: number
  currency: CurrencyCode
  frequency: DividendFrequency
  source: 'auto' | 'manual'
  mode?: DividendMode
  /** 现金 / 再投资是否已入账（幂等标记） */
  applied?: boolean
  appliedAt?: number
  /** 送转是否已应用到持仓 */
  bonusApplied?: boolean
  /** 公告原文（便于核对） */
  planText?: string
}

export interface DividendFile {
  version: 1
  records: DividendRecord[]
  /** 每个标的默认的分红方式 */
  prefs: Record<string, DividendMode>
  /** 自动抓取时间（用于本地缓存 TTL） */
  cache: Record<string, number>
}

export function createEmptyDividendFile(): DividendFile {
  return { version: 1, records: [], prefs: {}, cache: {} }
}

export function holdingKey(market: HoldingMarket, code: string): string {
  return `${market}:${code.trim().toUpperCase()}`
}

/** 自动源记录的 id 用「市场+代码+除息日」：重复抓取天然幂等 */
export function autoRecordId(market: HoldingMarket, code: string, exDate: string): string {
  return `auto_${holdingKey(market, code)}_${exDate}`
}

/* ------------------------------------------------------------------ *
 * 规范化 / 读写
 * ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FREQS: DividendFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual', 'irregular']
const MARKETS: HoldingMarket[] = ['cn', 'ashare', 'us', 'hk']

const dateOf = (v: unknown): string | undefined =>
  typeof v === 'string' && DATE_RE.test(v.slice(0, 10)) ? v.slice(0, 10) : undefined

function normalizeRecord(raw: unknown): DividendRecord | null {
  if (!isRecord(raw)) return null
  const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : ''
  const exDate = dateOf(raw.exDate)
  if (!code || !exDate) return null
  const market = MARKETS.includes(raw.market as HoldingMarket) ? (raw.market as HoldingMarket) : 'cn'
  const cashPerUnit = safeNum(raw.cashPerUnit)
  const after = Number(raw.afterTaxPerUnit)
  const bonus = Number(raw.bonusRatio)
  const freq = FREQS.includes(raw.frequency as DividendFrequency)
    ? (raw.frequency as DividendFrequency)
    : 'irregular'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : autoRecordId(market, code, exDate),
    code,
    market,
    name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
    itemId: typeof raw.itemId === 'string' && raw.itemId ? raw.itemId : undefined,
    exDate,
    recordDate: dateOf(raw.recordDate),
    payDate: dateOf(raw.payDate),
    declarationDate: dateOf(raw.declarationDate),
    cashPerUnit,
    afterTaxPerUnit: Number.isFinite(after) && after > 0 ? after : undefined,
    bonusRatio: Number.isFinite(bonus) && bonus > 0 ? bonus : undefined,
    currency: (typeof raw.currency === 'string' && raw.currency ? raw.currency : 'CNY') as CurrencyCode,
    frequency: freq,
    source: raw.source === 'manual' ? 'manual' : 'auto',
    mode: raw.mode === 'cash' || raw.mode === 'reinvest' ? raw.mode : undefined,
    applied: raw.applied === true,
    appliedAt: typeof raw.appliedAt === 'number' ? raw.appliedAt : undefined,
    bonusApplied: raw.bonusApplied === true,
    planText: typeof raw.planText === 'string' ? raw.planText : undefined,
  }
}

/** 脏数据不影响使用：无法识别的字段一律回落默认值 */
export function normalizeDividendFile(raw: unknown): DividendFile {
  const base = createEmptyDividendFile()
  if (!isRecord(raw)) return base
  const records = Array.isArray(raw.records)
    ? raw.records.map(normalizeRecord).filter((r): r is DividendRecord => r !== null)
    : []
  // 同 id 只保留最后一条
  const byId = new Map<string, DividendRecord>()
  for (const r of records) byId.set(r.id, r)

  const prefs: Record<string, DividendMode> = {}
  if (isRecord(raw.prefs)) {
    for (const [k, v] of Object.entries(raw.prefs)) {
      if (v === 'cash' || v === 'reinvest') prefs[k] = v
    }
  }
  const cache: Record<string, number> = {}
  if (isRecord(raw.cache)) {
    for (const [k, v] of Object.entries(raw.cache)) {
      const t = Number(v)
      if (Number.isFinite(t) && t > 0) cache[k] = t
    }
  }
  return { version: 1, records: [...byId.values()], prefs, cache }
}

export function loadDividendFile(): DividendFile {
  try {
    const raw = window.localStorage.getItem(DIVIDENDS_STORAGE_KEY)
    if (!raw) return createEmptyDividendFile()
    return normalizeDividendFile(JSON.parse(raw))
  } catch {
    return createEmptyDividendFile()
  }
}

export function saveDividendFile(file: DividendFile): string | null {
  try {
    window.localStorage.setItem(DIVIDENDS_STORAGE_KEY, JSON.stringify(file))
    return null
  } catch (e) {
    return e instanceof Error ? `分红数据保存失败：${e.message}` : '分红数据保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * 增删改（纯函数）
 * ------------------------------------------------------------------ */

/** 合并抓取/录入结果：同 id 覆盖，但保留用户已产生的状态（已入账、分红方式） */
export function upsertRecords(file: DividendFile, incoming: DividendRecord[]): DividendFile {
  const byId = new Map(file.records.map((r) => [r.id, r]))
  for (const next of incoming) {
    const prev = byId.get(next.id)
    byId.set(
      next.id,
      prev
        ? {
            ...next,
            mode: next.mode ?? prev.mode,
            applied: next.applied ?? prev.applied,
            appliedAt: next.appliedAt ?? prev.appliedAt,
            bonusApplied: next.bonusApplied ?? prev.bonusApplied,
            itemId: next.itemId ?? prev.itemId,
          }
        : next,
    )
  }
  return { ...file, records: [...byId.values()].sort((a, b) => a.exDate.localeCompare(b.exDate)) }
}

export function removeRecord(file: DividendFile, id: string): DividendFile {
  return { ...file, records: file.records.filter((r) => r.id !== id) }
}

export function patchRecord(file: DividendFile, id: string, patch: Partial<DividendRecord>): DividendFile {
  return { ...file, records: file.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
}

export function setPref(file: DividendFile, market: HoldingMarket, code: string, mode: DividendMode): DividendFile {
  return { ...file, prefs: { ...file.prefs, [holdingKey(market, code)]: mode } }
}

export function modeOf(file: DividendFile, market: HoldingMarket, code: string): DividendMode {
  return file.prefs[holdingKey(market, code)] ?? 'cash'
}

/* ------------------------------------------------------------------ *
 * 入账前的计算（纯函数，便于单测）
 * ------------------------------------------------------------------ */

export interface DividendTaxRates {
  /** 美股预扣税率 0~1 */
  us: number
  /** 港股预扣税率 0~1 */
  hk: number
}

/**
 * 每份（每股）税后金额。
 * - 自动源（A股公告）直接给了「扣税后」金额 → 用它，最准；
 * - 否则按市场税率换算（A股公告口径已含税，这里只对美股/港股生效）。
 */
export function afterTaxPerUnit(record: DividendRecord, tax: DividendTaxRates): number {
  if (record.afterTaxPerUnit !== undefined && record.afterTaxPerUnit > 0) return record.afterTaxPerUnit
  const rate = record.market === 'us' ? tax.us : record.market === 'hk' ? tax.hk : 0
  const safeRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0
  return record.cashPerUnit * (1 - safeRate)
}

/** 预估这笔分红的到账金额（人民币，税后）：份额 × 税后每份金额 → 折算 */
export function estimateAmountCny(
  portfolio: Portfolio,
  record: DividendRecord,
  tax: DividendTaxRates,
  rates?: FxRates | null,
): number {
  const holding = findHolding(portfolio, record)
  if (!holding) return 0
  const amount = (Number(holding.shares) || 0) * afterTaxPerUnit(record, tax)
  return roundMoney(toCny(amount, record.currency, rates) ?? amount)
}

/**
 * 金额保留两位（避免浮点尾数写进余额）。
 * 加 EPSILON 是为了让 1.005 这类「二进制表示略小于十进制中点」的值按常规四舍五入进位。
 */
export function roundMoney(v: number): number {
  if (!Number.isFinite(v)) return 0
  return (Math.sign(v) * Math.round((Math.abs(v) + Number.EPSILON) * 100)) / 100
}

/** 定位这笔分红对应的持仓条目：优先按 itemId，其次按「市场 + 代码」 */
/**
 * 找出这笔分红对应的**所有**持仓条目。
 * 「两个平台买了同一只基金」时会有同代码的多条 —— 分红、再投资、送转都要作用到全部，
 * 否则第二条永远不会更新。
 */
export function findHoldings(
  portfolio: Portfolio,
  record: Pick<DividendRecord, 'itemId' | 'market' | 'code'>,
): FundItem[] {
  const funds: FundItem[] = []
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (item.kind === 'fund') funds.push(item)
    }
  }
  if (record.itemId) {
    const byId = funds.filter((i) => i.id === record.itemId)
    if (byId.length > 0) return byId
  }
  const code = (record.code ?? '').trim().toUpperCase()
  if (!code) return []
  return funds.filter((i) => (i.market ?? 'cn') === record.market && i.code.trim().toUpperCase() === code)
}

/**
 * 这条分红对应的持仓是否已经不存在了（删掉股票/基金后，日历里会留下孤儿记录）。
 * 界面上据此提示并提供「清理」入口。
 */
export function isOrphanRecord(
  portfolio: Portfolio,
  record: Pick<DividendRecord, 'itemId' | 'market' | 'code'>,
): boolean {
  return findHoldings(portfolio, record).length === 0
}

/** 所有失效记录（持仓已删除） */
export function orphanRecords(
  portfolio: Portfolio,
  records: DividendRecord[],
): DividendRecord[] {
  return records.filter((r) => isOrphanRecord(portfolio, r))
}

/** 第一条匹配的持仓（保持旧行为；多处持仓时请用 findHoldings） */
export function findHolding(
  portfolio: Portfolio,
  record: Pick<DividendRecord, 'itemId' | 'market' | 'code'>,
): FundItem | undefined {
  return findHoldings(portfolio, record)[0]
}

/**
 * 分红再投资：把 totalAdd 份**按各条现有份额比例**分摊到多条持仓，
 * 每条的成本按自己的加权平均更新（最后一条吃掉余数，避免浮点丢份额）。
 */
export function reinvestSharesAcross(
  portfolio: Portfolio,
  targets: Array<{ id: string; shares: number }>,
  totalAdd: number,
  pricePerUnit: number,
): ApplyResult & { perItem: Array<{ itemId: string; add: number }> } {
  if (targets.length === 0) return { portfolio, ok: false, reason: '找不到对应持仓条目', perItem: [] }
  if (!Number.isFinite(totalAdd) || totalAdd <= 0) return { portfolio, ok: false, reason: '份额无效', perItem: [] }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
    return { portfolio, ok: false, reason: '再投资价格无效', perItem: [] }
  }
  const weights = targets.map((t) => Math.max(0, safeNum(t.shares)))
  const totalShares = weights.reduce((s, w) => s + w, 0)
  if (totalShares <= 0) return { portfolio, ok: false, reason: '该持仓份额为 0', perItem: [] }

  let next = portfolio
  const perItem: Array<{ itemId: string; add: number }> = []
  let remaining = totalAdd
  targets.forEach((target, index) => {
    const add = index === targets.length - 1 ? remaining : (totalAdd * weights[index]) / totalShares
    if (!(add > 0)) return
    const res = reinvestShares(next, target.id, add, pricePerUnit)
    if (res.ok) {
      next = res.portfolio
      perItem.push({ itemId: target.id, add })
      remaining -= add
    }
  })
  return { portfolio: next, ok: perItem.length > 0, perItem }
}

/* ------------------------------------------------------------------ *
 * 入账（纯函数：返回新的 Portfolio）
 * ------------------------------------------------------------------ */

export interface ApplyResult {
  portfolio: Portfolio
  ok: boolean
  reason?: string
}

/** 把一笔人民币金额加进某个「现金与固定资产」条目（分红 / 薪资入账共用） */
export function depositToCashItem(
  portfolio: Portfolio,
  target: { categoryId: string; itemId: string },
  amountCny: number,
): ApplyResult {
  if (!Number.isFinite(amountCny) || amountCny <= 0) return { portfolio, ok: false, reason: '金额无效' }
  const category = portfolio.categories.find((c) => c.id === target.categoryId)
  const item = category?.items.find((i) => i.id === target.itemId)
  if (!category || !item) return { portfolio, ok: false, reason: '找不到入账账户，请重新选择' }
  if (item.kind !== 'amount') return { portfolio, ok: false, reason: '入账账户必须是金额类条目' }
  if (item.currency && item.currency !== 'CNY') {
    // 外币账户需要按汇率换算，本期不做，避免静默记错数字
    return { portfolio, ok: false, reason: '该账户是外币账户，请改用人民币账户（或手动添加）' }
  }
  return {
    portfolio: {
      ...portfolio,
      categories: portfolio.categories.map((c) =>
        c.id !== category.id
          ? c
          : {
              ...c,
              items: c.items.map((i) =>
                i.id === item.id && i.kind === 'amount'
                  ? { ...i, amount: roundMoney(safeNum(i.amount) + amountCny) }
                  : i,
              ),
            },
      ),
    },
    ok: true,
  }
}

/** 分红再投资：增加份额，成本单价按「买入价」加权平均（买入价=除息日净值/收盘价） */
export function reinvestShares(
  portfolio: Portfolio,
  itemId: string,
  addShares: number,
  pricePerUnit: number,
): ApplyResult {
  if (!Number.isFinite(addShares) || addShares <= 0) return { portfolio, ok: false, reason: '份额无效' }
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) return { portfolio, ok: false, reason: '再投资价格无效' }
  let found = false
  const categories = portfolio.categories.map((c) => {
    if (!c.items.some((i) => i.id === itemId && i.kind === 'fund')) return c
    found = true
    return {
      ...c,
      items: c.items.map((i) => {
        if (i.id !== itemId || i.kind !== 'fund') return i
        const shares = safeNum(i.shares) + addShares
        const costNav = (safeNum(i.shares) * safeNum(i.costNav) + addShares * pricePerUnit) / (shares || 1)
        return { ...i, shares, costNav }
      }),
    }
  })
  if (!found) return { portfolio, ok: false, reason: '找不到对应持仓条目' }
  return { portfolio: { ...portfolio, categories }, ok: true }
}

/** 送股/转股：份额按比例增加，成本单价同比例摊薄（总市值不变） */
export function applyBonusShares(portfolio: Portfolio, itemId: string, ratioPer10: number): ApplyResult {
  if (!Number.isFinite(ratioPer10) || ratioPer10 <= 0) return { portfolio, ok: false, reason: '送转比例无效' }
  const factor = 1 + ratioPer10 / 10
  let found = false
  const categories = portfolio.categories.map((c) => {
    if (!c.items.some((i) => i.id === itemId && i.kind === 'fund')) return c
    found = true
    return {
      ...c,
      items: c.items.map((i) => {
        if (i.id !== itemId || i.kind !== 'fund') return i
        return {
          ...i,
          shares: safeNum(i.shares) * factor,
          costNav: safeNum(i.costNav) / factor,
        }
      }),
    }
  })
  if (!found) return { portfolio, ok: false, reason: '找不到对应持仓条目' }
  return { portfolio: { ...portfolio, categories }, ok: true }
}
