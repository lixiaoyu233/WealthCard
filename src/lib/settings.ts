/**
 * 应用设置：基金申购的资金来源规则 + 薪资记录
 *
 * 两类内容放在一起，因为都属于「一次性配置、长期生效」的东西，
 * 与资产数据分开存放（localStorage 独立键），互不污染。
 */

import type { Portfolio } from '../types/asset'
import type { TrendRange, TrendTab } from './netWorthHistory'

export const SETTINGS_STORAGE_KEY = 'asset-card-wallet/settings/v1'

/** 资金划拨来源：从某个现金/固资项目扣款买入基金 */
export interface FundingSource {
  /** 目标分类 id（通常是「现金与固定资产」里的某个条目所在分类） */
  categoryId: string
  /** 目标条目 id（金额类项目） */
  itemId: string
  /** 该项目的展示名，便于在基金条目上回显 */
  itemName: string
}

/** 走势可选指标 */

/** 基金/股票申购默认设置 */
export interface FundDefaults {
  /** 默认是否启用「从现有项目划拨」 */
  useFunding: boolean
  /** 上次选择的划拨来源，下次自动带出 */
  lastFundingSource?: FundingSource
}

/** 一条薪资记录 */
export interface SalaryRecord {
  /** 年月，格式 YYYY-MM */
  month: string
  amount: number
  /** 录入时间戳 */
  at: number
  /** 是否已经写入到现金项（避免重复入账） */
  applied?: boolean
  /** 写入时间 */
  appliedAt?: number
}

/** 固定薪资配置 */
export interface FixedSalary {
  enabled: boolean
  amount: number
  /** 每月发薪日 1~28（避开月末差异） */
  payday: number
  /** 发薪后写入哪个项目 */
  target?: FundingSource
}

/** 走势面板外观配置 */
export interface TrendsConfig {
  /** 是否在首页显示走势面板 */
  enabled: boolean
  /** 面板里展示哪几个标签页（至少保留一个） */
  metrics: TrendTab[]
  /** 打开时的默认时间范围 */
  range: TrendRange
  /** 是否在点上显示数值 */
  showLabels: boolean
  /** 是否显示环比 */
  showMom: boolean
  /** 是否按涨跌着色 */
  colorByTrend: boolean
}

/** 首页可配置区块（顶部净资产、资产分类、数据管理固定在首尾，不在此列） */
export type HomeBlockId = 'holdingsProfit' | 'strategy' | 'trends' | 'dividends'

/** 首页「中间区块」的显示开关与顺序 */
export interface HomeLayoutConfig {
  /** 显示顺序，只包含中间可配置区块 */
  order: HomeBlockId[]
  /** 各区块是否显示 */
  visible: Record<HomeBlockId, boolean>
}

/** 当前版本支持的首页区块（以后新增功能只要在这里加一项） */
export const HOME_BLOCK_IDS: HomeBlockId[] = ['holdingsProfit', 'strategy', 'trends', 'dividends']

/** 首页区块文案，设置页与首页共用一份 */
export const HOME_BLOCK_LABEL: Record<HomeBlockId, { title: string; desc: string }> = {
  holdingsProfit: { title: '持仓总盈亏', desc: '场外基金、场内基金与美股/港股的浮动盈亏' },
  strategy: { title: '投资策略与再平衡', desc: '配置建议、偏离度与调整金额' },
  trends: { title: '走势面板', desc: '净资产 / 总资产 / 负债 / 薪资的历史曲线' },
  dividends: { title: '分红日历', desc: '本月已确认 / 按历史推算的分红，以及已产生的分红' },
}

/** 默认顺序：持仓总盈亏 → 投资策略 → 走势；以后新增的区块追加在末尾 */
const DEFAULT_HOME_ORDER: HomeBlockId[] = [...HOME_BLOCK_IDS]

const DEFAULT_HOME_VISIBLE: Record<HomeBlockId, boolean> = {
  holdingsProfit: true,
  strategy: false,
  trends: false,
  // 新增区块默认关闭：老用户升级后首页不会突然多出一块，自己去「首页显示」打开
  dividends: false,
}

/** 规范化首页顺序：丢弃未知项与重复项，缺失项按默认顺序补到末尾 */
export function normalizeHomeOrder(raw: unknown): HomeBlockId[] {
  const out: HomeBlockId[] = []
  const seen = new Set<HomeBlockId>()
  if (Array.isArray(raw)) {
    for (const v of raw as unknown[]) {
      if (typeof v !== 'string' || !HOME_BLOCK_IDS.includes(v as HomeBlockId)) continue
      const id = v as HomeBlockId
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  for (const id of DEFAULT_HOME_ORDER) if (!seen.has(id)) out.push(id)
  return out
}

/** 上移 / 下移一位；越界时原样返回 */
export function moveHomeBlock(order: HomeBlockId[], id: HomeBlockId, dir: -1 | 1): HomeBlockId[] {
  const idx = order.indexOf(id)
  const target = idx + dir
  if (idx < 0 || target < 0 || target >= order.length) return order
  const next = [...order]
  ;[next[idx], next[target]] = [next[target], next[idx]]
  return next
}

/** 分红相关设置 */
export interface DividendSettings {
  /** 现金分红的默认入账账户（只允许「现金与固定资产」里的金额类条目） */
  defaultCashTarget?: FundingSource
  /** 美股预扣税率（0~1，如 0.1 / 0.3）——中国居民常见 10%（W-8BEN）或 30% */
  usTaxRate: number
  /** 港股预扣税率（0~1，如 H 股 10%） */
  hkTaxRate: number
  /** 新标的的默认分红方式 */
  defaultMode: 'cash' | 'reinvest'
}

export interface AppSettings {
  version: number
  fund: FundDefaults
  /** 走势面板配置（在设置里选指标，卡片内不再选） */
  trends: TrendsConfig
  /** 首页显示哪些中间区块、按什么顺序 */
  home: HomeLayoutConfig
  /** 分红：默认入账账户、港美股税率、默认分红方式 */
  dividends: DividendSettings
  salary: {
    /** 按月存档的薪资记录 */
    records: SalaryRecord[]
    fixed: FixedSalary
  }
}

export function createDefaultSettings(): AppSettings {
  return {
    version: 1,
    trends: {
      enabled: false,
      metrics: ['netWorth'],
      range: '1y',
      showLabels: true,
      showMom: true,
      colorByTrend: true,
    },
    home: { order: [...DEFAULT_HOME_ORDER], visible: { ...DEFAULT_HOME_VISIBLE } },
    dividends: { usTaxRate: 0.1, hkTaxRate: 0.1, defaultMode: 'cash' },
    fund: { useFunding: false },
    salary: {
      records: [],
      fixed: { enabled: false, amount: 0, payday: 10 },
    },
  }
}

/* ------------------------------------------------------------------ *
 * 时间工具
 * ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0')

/** 当前年月，YYYY-MM */
export function currentMonth(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 「2026-10」→「2026年10月」 */
export function formatMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${Number(m[2])}月` : month
}

/** 当月是否已到发薪日（含） */
export function isPaydayReached(payday: number, d = new Date()): boolean {
  return d.getDate() >= Math.min(28, Math.max(1, payday))
}

/* ------------------------------------------------------------------ *
 * 规范化
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeSource(raw: unknown): FundingSource | undefined {
  if (!isRecord(raw)) return undefined
  const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId : ''
  const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
  if (!categoryId || !itemId) return undefined
  return {
    categoryId,
    itemId,
    itemName: typeof raw.itemName === 'string' ? raw.itemName : '现金项目',
  }
}

const ALL_METRICS: TrendTab[] = ['netWorth', 'assets', 'liabilities', 'salary']
const ALL_RANGES: TrendRange[] = ['6m', '1y', '3y', 'all']

/** 走势配置：兼容 v1 的顶层开关与旧 showChart 字段 */
function normalizeTrends(raw: Record<string, unknown>, salary: Record<string, unknown>): TrendsConfig {
  const base = createDefaultSettings().trends
  const t = isRecord(raw.trends) ? raw.trends : {}
  const legacyEnabled = raw.trendsEnabled === true || salary.showChart === true

  const metricsRaw = Array.isArray(t.metrics) ? (t.metrics as unknown[]) : null
  const metrics = metricsRaw
    ? metricsRaw.filter((m): m is TrendTab => typeof m === 'string' && ALL_METRICS.includes(m as TrendTab))
    : // 旧数据：开关打开时曾经固定展示全部指标
      legacyEnabled
      ? ALL_METRICS
      : base.metrics

  const rangeRaw = typeof t.range === 'string' ? (t.range as TrendRange) : base.range

  return {
    enabled: typeof t.enabled === 'boolean' ? t.enabled : legacyEnabled,
    // 至少保留一个指标，否则面板会空白
    metrics: metrics.length > 0 ? metrics : ['netWorth'],
    range: ALL_RANGES.includes(rangeRaw) ? rangeRaw : base.range,
    showLabels: t.showLabels === undefined ? base.showLabels : t.showLabels === true,
    showMom: t.showMom === undefined ? base.showMom : t.showMom === true,
    colorByTrend: t.colorByTrend === undefined ? base.colorByTrend : t.colorByTrend === true,
  }
}

/** 分红设置：脏数据一律回落默认值，税率限制在 0~1 */
function normalizeDividendSettings(raw: Record<string, unknown>): DividendSettings {
  const base = { usTaxRate: 0.1, hkTaxRate: 0.1, defaultMode: 'cash' as const }
  const d = isRecord(raw.dividends) ? raw.dividends : null
  const rate = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback
  }
  return {
    defaultCashTarget: d ? normalizeSource(d.defaultCashTarget) : undefined,
    usTaxRate: d ? rate(d.usTaxRate, base.usTaxRate) : base.usTaxRate,
    hkTaxRate: d ? rate(d.hkTaxRate, base.hkTaxRate) : base.hkTaxRate,
    defaultMode: d && d.defaultMode === 'reinvest' ? 'reinvest' : 'cash',
  }
}

/** 首页区块配置：老数据没有 home 时，走势的开关沿用原来的 trends.enabled */
function normalizeHome(raw: Record<string, unknown>, legacyTrendsEnabled: boolean): HomeLayoutConfig {
  const h = isRecord(raw.home) ? raw.home : null
  const order = normalizeHomeOrder(h ? h.order : undefined)
  const visible: Record<HomeBlockId, boolean> = { ...DEFAULT_HOME_VISIBLE }
  const visibleRaw = h && isRecord(h.visible) ? h.visible : null
  if (visibleRaw) {
    for (const id of HOME_BLOCK_IDS) {
      const v = visibleRaw[id]
      if (typeof v === 'boolean') visible[id] = v
    }
  } else {
    visible.trends = legacyTrendsEnabled
  }
  return { order, visible }
}

/** 把任意来源的数据规范化为当前 Schema（脏数据不影响使用） */
export function normalizeSettings(raw: unknown): AppSettings {
  const base = createDefaultSettings()
  if (!isRecord(raw)) return base

  const fund = isRecord(raw.fund) ? raw.fund : {}
  const salary = isRecord(raw.salary) ? raw.salary : {}
  const fixed = isRecord(salary.fixed) ? salary.fixed : {}

  const parsed: SalaryRecord[] = []
  if (Array.isArray(salary.records)) {
    for (const r of salary.records as unknown[]) {
      if (!isRecord(r)) continue
      const month = typeof r.month === 'string' ? r.month : ''
      const amount = Number(r.amount)
      if (!/^\d{4}-\d{2}$/.test(month) || !Number.isFinite(amount)) continue
      parsed.push({
        month,
        amount,
        at: Number(r.at) || Date.now(),
        applied: r.applied === true,
        appliedAt: typeof r.appliedAt === 'number' ? r.appliedAt : undefined,
      })
    }
  }
  // 同月只保留最后一条，避免脏数据出现重复月份
  const byMonth = new Map<string, SalaryRecord>()
  for (const rec of parsed) byMonth.set(rec.month, rec)
  const records = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))

  const paydayRaw = Number(fixed.payday)

  /**
   * 走势面板「是否显示」现在统一由 home.visible.trends 决定。
   * 老数据没有 home 时沿用旧的 trends.enabled；随后把 trends.enabled 同步成 home 的值，
   * 这样即便回滚到旧版本，用户的开关设置也不会丢。
   */
  const trends = normalizeTrends(raw, salary)
  const home = normalizeHome(raw, trends.enabled)
  trends.enabled = home.visible.trends

  return {
    version: 1,
    fund: {
      useFunding: fund.useFunding === true,
      lastFundingSource: normalizeSource(fund.lastFundingSource),
    },
    home,
    dividends: normalizeDividendSettings(raw),
    // 兼容旧数据：v1 用顶层 trendsEnabled / salary.showChart 表示开关，
    // 且当时面板固定展示全部四个指标
    trends,
    salary: {
      records,
      fixed: {
        enabled: fixed.enabled === true,
        amount: Number.isFinite(Number(fixed.amount)) ? Number(fixed.amount) : 0,
        // 限制在 1~28：避免 29~31 在小月不存在
        payday: Number.isFinite(paydayRaw) ? Math.min(28, Math.max(1, Math.round(paydayRaw))) : 10,
        target: normalizeSource(fixed.target),
      },
    },
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return createDefaultSettings()
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return createDefaultSettings()
  }
}

export function saveSettings(settings: AppSettings): string | null {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    return null
  } catch (e) {
    return e instanceof Error ? `设置保存失败：${e.message}` : '设置保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * 薪资：写入现金项（幂等）
 * ------------------------------------------------------------------ */

export interface ApplyResult {
  portfolio: Portfolio
  /** 本次是否真的写入了 */
  applied: boolean
  /** 写入金额 */
  amount: number
  /** 写入到哪个项目 */
  itemName?: string
  /** 未能写入的原因 */
  reason?: string
}

/**
 * 把某月的薪资写入指定现金项目。
 *
 * 幂等保证：
 * 1. 该月记录已标记 applied 时直接返回，不会重复入账；
 * 2. 调用方（reducer）在同一动作里完成「加余额 + 标记 applied」。
 */
export function applySalaryToPortfolio(
  portfolio: Portfolio,
  settings: AppSettings,
  month: string,
): ApplyResult {
  const record = settings.salary.records.find((r) => r.month === month)
  if (!record) return { portfolio, applied: false, amount: 0, reason: `${month} 没有薪资记录` }
  if (record.applied) return { portfolio, applied: false, amount: 0, reason: '该月薪资已入账，未重复添加' }

  const target = settings.salary.fixed.target
  if (!target) return { portfolio, applied: false, amount: 0, reason: '还没选择发薪写入的项目' }
  if (!(record.amount > 0)) return { portfolio, applied: false, amount: 0, reason: '薪资金额需要大于 0' }

  let found = false
  const categories = portfolio.categories.map((c) => {
    if (c.id !== target.categoryId) return c
    const items = c.items.map((i) => {
      if (i.id !== target.itemId || i.kind !== 'amount') return i
      found = true
      return { ...i, amount: i.amount + record.amount }
    })
    return { ...c, items }
  })

  if (!found) return { portfolio, applied: false, amount: 0, reason: '目标项目已不存在，请在设置里重新选择' }
  return { portfolio: { ...portfolio, categories }, applied: true, amount: record.amount, itemName: target.itemName }
}

/** 判断某月薪资是否应该自动入账（到了发薪日、有金额、且未入账） */
export function shouldAutoApply(
  settings: AppSettings,
  month: string,
  now = new Date(),
): boolean {
  const { fixed, records } = settings.salary
  if (!fixed.enabled || !fixed.target || fixed.amount <= 0) return false
  const record = records.find((r) => r.month === month)
  if (!record || record.applied) return false
  return isPaydayReached(fixed.payday, now)
}

/* ------------------------------------------------------------------ *
 * 现金项目候选（可划拨 / 可入账的来源）
 * ------------------------------------------------------------------ */

export interface CashCandidate {
  categoryId: string
  categoryName: string
  itemId: string
  itemName: string
  amount: number
}

/**
 * 列出可作为资金划拨来源的条目。
 *
 * 规则（与用户确认过）：只列出「金额类」条目，且当前金额为正 ——
 * 基金持仓、黄金这类本身是投资品的条目不能当资金来源；
 * 余额为负（欠款）的项目也不适合再扣。
 */
export function listCashCandidates(portfolio: Portfolio): CashCandidate[] {
  const out: CashCandidate[] = []
  for (const category of portfolio.categories) {
    if (category.isLiability) continue
    for (const item of category.items) {
      if (item.kind !== 'amount') continue
      const amount = Number(item.amount) || 0
      if (amount <= 0) continue
      out.push({
        categoryId: category.id,
        categoryName: category.name,
        itemId: item.id,
        itemName: item.name,
        amount,
      })
    }
  }
  return out.sort((a, b) => b.amount - a.amount)
}

/** 入账目标所在的内置分类：「现金与固定资产」 */
export const CASH_CATEGORY_ID = 'cat_cash'

/**
 * 可**入账**的现金项目（薪资、分红写入用）。
 *
 * 与「资金来源」的关键区别：入账是**加钱**，所以余额为 0（甚至负数）也必须可选 ——
 * 新建的「招行活期」余额就是 0，旧规则会把它排除掉，导致「没有可选项」。
 * 另外按确认过的口径：只列「现金与固定资产」这一个分类下的金额类条目。
 */
export function listDepositTargets(portfolio: Portfolio): CashCandidate[] {
  const out: CashCandidate[] = []
  for (const category of portfolio.categories) {
    if (category.id !== CASH_CATEGORY_ID) continue
    for (const item of category.items) {
      if (item.kind !== 'amount') continue
      out.push({
        categoryId: category.id,
        categoryName: category.name,
        itemId: item.id,
        itemName: item.name,
        amount: Number(item.amount) || 0,
      })
    }
  }
  return out.sort((a, b) => b.amount - a.amount)
}

/** 空状态要说清「为什么没有可选项」，否则用户不知道去哪加 */
export interface DepositTargetDiagnosis {
  categoryFound: boolean
  categoryName?: string
  /** 「现金与固定资产」下的条目总数 */
  itemCount: number
  /** 其中金额类的数量（只有金额类才能入账） */
  amountItemCount: number
}

export function diagnoseDepositTargets(portfolio: Portfolio): DepositTargetDiagnosis {
  const category = portfolio.categories.find((c) => c.id === CASH_CATEGORY_ID)
  if (!category) return { categoryFound: false, itemCount: 0, amountItemCount: 0 }
  return {
    categoryFound: true,
    categoryName: category.name,
    itemCount: category.items.length,
    amountItemCount: category.items.filter((i) => i.kind === 'amount').length,
  }
}

/** 按 id 找候选项目，便于回显与校验 */
export function findCandidate(
  candidates: CashCandidate[],
  source: FundingSource | undefined,
): CashCandidate | undefined {
  if (!source) return undefined
  return candidates.find((c) => c.itemId === source.itemId && c.categoryId === source.categoryId)
}
