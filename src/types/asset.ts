/** 资产条目形态 */
export type ItemKind = 'amount' | 'fund' | 'gold'

/** 基金归属的资产类型（与 calc.FUND_ASSET_CLASS_LABEL 对应） */
export type FundAssetClass = 'equity' | 'bond' | 'money' | 'commodity' | 'mixed' | 'unknown'

/** 币种（预留多币种展示，暂以 CNY 计价） */
export type Currency = 'CNY'

/** 金额形态条目（现金 / 房产 / 负债等直接录入金额的场景） */
export interface AmountItem extends BaseItem {
  kind: 'amount'
  /** 金额（可为负，负债通常以正数录入并由分类的 isLiability 扣减） */
  amount: number
}

export interface BaseItem {
  id: string
  /**
   * 所属分类由 Portfolio.categories[].id 承载，条目内部不再冗余存储，
   * 便于分类改名 / 排序时不产生数据不一致。
   */
  kind: ItemKind
  name: string
  /** 备注，展示为卡片列表里的小字 */
  note?: string
}

/** 基金条目：以真实基金代码 + 份额 + 成本单价登记 */
export interface FundItem extends BaseItem {
  kind: 'fund'
  /** 6 位基金代码 */
  code: string
  /** 持有份额 */
  shares: number
  /** 成本单价（每份成本） */
  costNav: number
  /** 用户是否自定义过名称；未自定义时用接口返回的基金全称自动补全 */
  manualName?: boolean
  /**
   * 用户手动标记的资产类型；不填时由基金名称关键词自动识别（见 calc.effectiveFundClass）。
   * 再平衡计算会用它把基金归到「股票」或「债券」等策略类别。
   */
  assetClass?: FundAssetClass
  /** 最近一次同步到的行情快照 */
  quote?: FundQuote
}

/** 黄金条目：按克数 + 单价登记，支持实时金价手工刷新 */
export interface GoldItem extends BaseItem {
  kind: 'gold'
  /** 持有克数 */
  grams: number
  /** 计价单价（元/克） */
  pricePerGram: number
}

export type AssetItem = AmountItem | FundItem | GoldItem

/** 基金行情快照，由天天基金接口回填 */
export interface FundQuote {
  code: string
  /** 基金全称，如「招商中证白酒指数(LOF)A」 */
  name: string
  /** 交易日盘中估算净值（接口 GSZ），QDII / 非交易时段为空 */
  estimatedNav?: number
  /** 盘中估算涨跌幅（小数，如 0.0212 表示 +2.12%） */
  estimatedRate?: number
  /** 估算时间，如 2026-10-03 14:30 */
  estimatedAt?: string
  /** 最新公布单位净值（接口 NAV） */
  publishedNav?: number
  /** 最新公布净值的涨跌幅（小数） */
  publishedRate?: number
  /** 净值公布日期，如 2026-09-30 */
  publishedAt?: string
  /** 最近一次估值更新时间戳（毫秒） */
  fetchedAt: number
  /** 数据来源，便于排查 */
  source: string
}

/** 资产分类（卡片） */
export interface Category {
  id: string
  name: string
  /** 副标题描述，如「银行 / 房产 / 现金」 */
  subtitle: string
  /** lucide 图标名，见 lib/icons.ts 的映射白名单 */
  icon: string
  /** 主题色 hex，用于图标底色与强调色 */
  color: string
  /** 是否计入负债（负债类金额取负参与净资产计算） */
  isLiability?: boolean
  items: AssetItem[]
}

/** 净资产历史快照，用于「较上次」变化提示 */
export interface HistoryPoint {
  /** 快照日期 YYYY-MM-DD */
  date: string
  netWorth: number
  totalAssets: number
  totalLiabilities: number
  /** 快照时间戳 */
  at: number
}

export interface Portfolio {
  version: number
  categories: Category[]
  history: HistoryPoint[]
  /** 最近一次整体刷新时间戳 */
  lastSyncedAt?: number
}

/** 汇总结果 */
export interface Summary {
  netWorth: number
  totalAssets: number
  totalLiabilities: number
}

/** 单个条目的估值结果 */
export interface ItemValuation {
  /** 当前市值 */
  value: number
  /** 成本 */
  cost?: number
  /** 盈亏金额（仅 fund / gold 有意义） */
  profit?: number
  /** 盈亏比例（小数） */
  profitRate?: number
}
