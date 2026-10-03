import type {
  AssetItem,
  Category,
  FundItem,
  FundQuote,
  GoldItem,
  ItemValuation,
  Portfolio,
  Summary,
} from '../types/asset'

/* ------------------------------------------------------------------ *
 * 类型守卫
 * ------------------------------------------------------------------ */

export function isFund(item: AssetItem): item is FundItem {
  return item.kind === 'fund'
}

export function isGold(item: AssetItem): item is GoldItem {
  return item.kind === 'gold'
}

/* ------------------------------------------------------------------ *
 * 基金资产类型识别
 * ------------------------------------------------------------------ */

/** 基金归属的资产类型：股票型 / 债券型 / 货币 / 黄金商品 / 混合 / 未知 */
export type FundAssetClass = 'equity' | 'bond' | 'money' | 'commodity' | 'mixed' | 'unknown'

export const FUND_ASSET_CLASS_LABEL: Record<FundAssetClass, string> = {
  equity: '股票型',
  bond: '债券型',
  money: '货币型',
  commodity: '黄金 / 商品',
  mixed: '混合型',
  unknown: '未识别',
}

/**
 * 依据基金名称关键词判断资产类型。
 *
 * 为什么不调接口取类型：天天基金的行情接口稳定返回的只有净值相关字段，
 * 基金类型字段会随接口版本变化，纯前端依赖它容易在接口调整后失效。
 * 名称关键词是「永远拿得到」的信息，再配合用户手动标记兜底，稳定性更好。
 */
export function detectFundClass(name: string | undefined): FundAssetClass {
  const n = (name ?? '').trim()
  if (!n) return 'unknown'
  // 可转债基金本质偏债，但名字里同时有「债」和「股」，先单独识别
  if (/可转债|转债/.test(n)) return 'bond'
  if (/(货币|现金宝|活期宝|理财金)/.test(n)) return 'money'
  if (/(债券|纯债|短债|中短债|信用债|利率债|国债|城投债|固收|债基|债[ABCEHI]?\b)/.test(n)) return 'bond'
  if (/(黄金|贵金属|白银|有色|原油|商品|能源化工|豆粕)/.test(n)) return 'commodity'
  if (/(股票|指数|ETF|联接|LOF|增强|成长|价值|红利|消费|医药|科技|新能源|半导体|军工|券商|银行|地产|白酒|沪深|中证|标普|纳斯达克|恒生|MSCI)/i.test(n)) {
    return 'equity'
  }
  if (/(混合|灵活配置|平衡|稳健|绝对收益|养老目标)/.test(n)) return 'mixed'
  return 'unknown'
}

/** 取基金的有效资产类型：用户标记优先，其次按名称识别 */
export function effectiveFundClass(item: FundItem): FundAssetClass {
  return item.assetClass ?? detectFundClass(item.name)
}

/**
 * 把识别出来的基金类型映射到给定策略里的候选类别 id。
 * 返回全部候选（按优先级排序），由调用方结合策略目标比例挑最合适的那个 ——
 * 例如债券型基金在全天候里既有「长期国债」也有「中期国债」，应当归到中期国债。
 */
export function fundClassToStrategyClasses(
  fundClass: FundAssetClass,
  strategyClassIds: string[],
): string[] {
  const has = (id: string) => strategyClassIds.includes(id)
  const pick = (...ids: string[]) => ids.filter(has)
  switch (fundClass) {
    case 'bond':
    case 'money':
      return pick('bond', 'bond-long', 'bond-mid', 'cash')
    case 'commodity':
      return pick('commodity', 'gold')
    case 'equity':
    case 'mixed':
      return pick('stock')
    default:
      return []
  }
}

/* ------------------------------------------------------------------ *
 * 数值工具
 * ------------------------------------------------------------------ */

/** 安全数字：NaN / Infinity / null / undefined 一律归零 */
export function safeNum(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v : 0
}

/**
 * 解析用户输入的金额文本。
 * 支持：千分位逗号、全角数字/句号、¥ 符号、前后空格，以及「万 / w / k」中文数量级。
 * 返回 NaN 表示不可解析，由表单负责校验提示。
 */
export function parseAmount(input: string): number {
  if (typeof input !== 'string') return NaN
  let s = input
    .trim()
    .replace(/[，,]/g, '')
    .replace(/[¥￥\s]/g, '')
    // 全角数字与句号转半角
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/。/g, '.')
    .replace(/[＋]/g, '+')
    .replace(/[－ー—]/g, '-')

  let scale = 1
  if (/[万萬]$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  } else if (/[kK]$/.test(s)) {
    scale = 1_000
    s = s.slice(0, -1)
  } else if (/[wW]$/.test(s)) {
    scale = 10_000
    s = s.slice(0, -1)
  }

  if (s === '' || s === '-' || s === '+') return NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN
  return Number(s) * scale
}

/* ------------------------------------------------------------------ *
 * 估值
 * ------------------------------------------------------------------ */

/**
 * 基金当前计价净值：
 * 优先取盘中估算净值（GSZ），无则回退到最新公布净值（NAV）。
 */
export function fundCurrentNav(item: FundItem): number | undefined {
  const q = item.quote
  if (!q) return undefined
  if (typeof q.estimatedNav === 'number' && q.estimatedNav > 0) return q.estimatedNav
  if (typeof q.publishedNav === 'number' && q.publishedNav > 0) return q.publishedNav
  return undefined
}

/** 单个条目的市值 / 成本 / 盈亏 */
export function valuate(item: AssetItem): ItemValuation {
  if (isFund(item)) {
    const nav = fundCurrentNav(item)
    const shares = safeNum(item.shares)
    const costNav = safeNum(item.costNav)
    if (nav === undefined) {
      // 尚未同步到行情时，用成本单价兜底，保证净资产不为 0 且不虚报盈亏
      const fallback = shares * costNav
      return { value: fallback, cost: fallback, profit: 0, profitRate: 0 }
    }
    const value = shares * nav
    const cost = shares * costNav
    const profit = value - cost
    return {
      value,
      cost,
      profit,
      profitRate: cost > 0 ? profit / cost : 0,
    }
  }

  if (isGold(item)) {
    const grams = safeNum(item.grams)
    const price = safeNum(item.pricePerGram)
    const value = grams * price
    // 黄金只登记当前单价，没有独立成本价时以现价为成本（盈亏 0）
    return { value, cost: value, profit: 0, profitRate: 0 }
  }

  const amount = safeNum(item.amount)
  return { value: amount, cost: undefined, profit: undefined, profitRate: undefined }
}

/** 分类小计（负债类金额本身以负数存储，直接累加） */
export function categoryTotal(category: Category): number {
  return category.items.reduce((sum, item) => sum + valuate(item).value, 0)
}

/** 分类项数标签文案，如「3项」「1只」「1笔」 */
export function categoryCountLabel(category: Category): string {
  const n = category.items.length
  if (n === 0) return '暂无'
  if (category.isLiability) return `${n}笔`
  const kinds = new Set(category.items.map((i) => i.kind))
  if (kinds.size === 1) {
    const only = [...kinds][0]
    if (only === 'fund') return `${n}只`
    if (only === 'gold') return `${n}笔`
  }
  return `${n}项`
}

/**
 * 全量汇总：
 * - 「负债」分类内的条目按绝对值计入 totalLiabilities；
 * - 其余分类按正负号计入 totalAssets（金额为正视为资产，为负则抵减资产）；
 * - 净资产 = 总资产 − 总负债。
 */
export function summarize(portfolio: Portfolio): Summary {
  let assets = 0
  let liabilities = 0

  for (const category of portfolio.categories) {
    const subtotal = categoryTotal(category)
    if (category.isLiability) {
      liabilities += Math.abs(subtotal)
    } else {
      assets += subtotal
    }
  }

  return {
    netWorth: assets - liabilities,
    totalAssets: assets,
    totalLiabilities: liabilities,
  }
}

/** 分类内是否含有需要联网刷新行情的条目 */
export function categoryNeedsSync(category: Category): boolean {
  return category.items.some((i) => isFund(i))
}

/** 收集全部基金代码（去重、仅保留 6 位数字） */
export function collectFundCodes(portfolio: Portfolio): string[] {
  const codes = new Set<string>()
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (isFund(item) && /^\d{6}$/.test(item.code)) codes.add(item.code)
    }
  }
  return [...codes]
}

/** 查询某只基金在所有分类中的持仓分布 */
export function findFundHoldings(
  portfolio: Portfolio,
  code: string,
): Array<{ category: Category; item: FundItem }> {
  const out: Array<{ category: Category; item: FundItem }> = []
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (isFund(item) && item.code === code) out.push({ category, item })
    }
  }
  return out
}

/** 判断行情是否需要刷新（默认 30 分钟视为过期） */
export const QUOTE_STALE_MS = 30 * 60 * 1000

export function isQuoteStale(quote: FundQuote | undefined, now = Date.now()): boolean {
  if (!quote?.fetchedAt) return true
  return now - quote.fetchedAt > QUOTE_STALE_MS
}
