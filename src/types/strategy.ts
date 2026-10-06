/**
 * 投资策略与再平衡相关的数据模型。
 *
 * 设计要点：
 * - 「策略资产类别」（StrategyClass）是再平衡的计算维度，与用户自己的资产分类（Category）是两套东西，
 *   两者通过「映射」（MappingEntry[]）关联，且允许一个分类按比例拆分到多个类别（如「基金」拆到股票+债券）。
 * - 所有结构都可 JSON 序列化，直接存进 localStorage。
 */

/** 内置策略 id */
export type BuiltinStrategyId = 'all-weather' | 'permanent' | 'classic-60-40'

/** 策略 id：内置三档 + 用户自定义 */
export type StrategyId = BuiltinStrategyId | string

/**
 * 策略类别的「语义」：用于把穿透出来的资产占比（AssetMix）自动落到对应类别上。
 * 内置策略按 id 推断；用户自定义策略可手改，或用 id/名称自动猜。
 */
export type AssetSemantic =
  | 'stock'
  | 'bond'
  | 'bond-long'
  | 'bond-mid'
  | 'cash'
  | 'gold'
  | 'commodity'
  | 'other'

export const SEMANTIC_LABEL: Record<AssetSemantic, string> = {
  stock: '股票',
  bond: '债券',
  'bond-long': '长期债券',
  'bond-mid': '中短期债券',
  cash: '现金',
  gold: '黄金',
  commodity: '大宗商品',
  other: '其他',
}

/** 策略资产类别（再平衡的计算维度） */
export interface StrategyClass {
  id: string
  name: string
  /** 该类别在「资产语义」上算哪一类；缺省时按 id / 名称推断 */
  semantic?: AssetSemantic
  /** 目标比例，百分比数值（30 表示 30%），同一策略内合计必须为 100 */
  target: number
  /** 图表用主题色（`var(--accent-*)`） */
  color: string
  /** 色名，用于取半透明底色；缺省表示自定义色 */
  colorName?: string
}

export interface Strategy {
  id: StrategyId
  name: string
  /**
   * 数据来源：内置策略 / 经典60/40 / 用户自定义。
   * builtin 的策略允许「重置为默认」，不允许删除。
   */
  kind: 'builtin' | 'custom'
  description: string
  classes: StrategyClass[]
}

/** 一个用户分类到某个策略类别的映射（同一分类下所有 target 合计为 100） */
export interface MappingEntry {
  /** StrategyClass.id */
  strategyClassId: string
  /** 该分类中多少比例归入这个策略类别，百分比数值 */
  percent: number
}

/** 分类 id -> 映射条目 */
export type CategoryMapping = Record<string, MappingEntry[]>

/**
 * 单个条目的映射规则（优先于分类映射）。
 *
 * key 用「标的身份」而不是条目 id：
 * - 有代码的（基金 / 股票 / ETF）→ `market:code`，这样同标的在多个账户里设置一次即生效，
 *   条目删掉重建、导出后重新导入、换设备导入 JSON，映射都还在；
 * - 没有代码的（银行理财、保险、自住房）→ `id:<itemId>`。
 */
export type ItemMapping = Record<string, ItemMappingRule>

export interface ItemMappingRule {
  /** 手动指定的目标桶与占比；留空表示沿用自动识别 */
  entries?: MappingEntry[]
  /** 手动锁定的资产占比（穿透结果的手动覆盖） */
  mix?: AssetMix
  /** 国债期限：决定全天候里落「长期国债」还是「中期国债」 */
  bondTerm?: 'long' | 'mid'
  /** 完全不纳入配置（带「房」、保险/年金等） */
  excluded?: boolean
  /** 来源：手动设置 / 自动识别 */
  source?: 'manual' | 'auto'
  updatedAt?: number
}

/** 资产占比向量（和为 1）。六档与三个内置策略的桶一一对应，避免黄金/商品糊在一起 */
export interface AssetMix {
  equity: number
  bond: number
  money: number
  gold: number
  commodity: number
  other: number
}

export const MIX_KEYS: Array<keyof AssetMix> = ['equity', 'bond', 'money', 'gold', 'commodity', 'other']

export const MIX_LABEL: Record<keyof AssetMix, string> = {
  equity: '股票',
  bond: '债券',
  money: '现金',
  gold: '黄金',
  commodity: '大宗商品',
  other: '其他',
}

/** 一个分类在各策略类别上的金额分布（用于展示与建议计算） */
export interface CategoryAllocation {
  categoryId: string
  categoryName: string
  categoryColor: string
  /** 分类当前市值（负债类为负数） */
  value: number
  /** strategyClassId -> 金额 */
  byClass: Record<string, number>
}

/** 调整建议 */
export type RebalanceAction = 'buy' | 'sell' | 'hold'

/** 单个策略类别的再平衡结果 */
export interface ClassRebalance {
  classId: string
  name: string
  color: string
  /** 目标比例（0~1） */
  targetWeight: number
  /** 当前实际比例（0~1） */
  actualWeight: number
  /** 偏离度 = 实际 − 目标（正数表示超配），单位：比例 */
  deviation: number
  /** 偏离度换算成百分点，便于展示（如 4.2 表示 4.2 个百分点） */
  deviationPoints: number
  /** 按目标比例应有的金额 */
  targetValue: number
  /** 当前实际金额 */
  currentValue: number
  /** 建议调整金额（正数=买入，负数=卖出），已按可动用资金裁剪 */
  adjustAmount: number
  /**
   * 无法自动执行、需要手动处理的金额（正数）。
   * 典型场景：活期存款、房产超配，但没有可卖出的基金份额，只能手动挪动。
   */
  manualAmount: number
  /**
   * 理论缺口金额（未裁剪），= 目标金额 − 当前金额。
   * 用于展示「应该」调多少，adjustAmount 是「实际能」调多少。
   */
  gapAmount: number
  action: RebalanceAction
  /** 该类别中可减仓的明细（按盈亏从优到劣排序，仅基金/黄金类有） */
  sellCandidates: SellCandidate[]
  /** 是否有映射到该类别、但缺少行业类型信息的持仓（提示用户去补） */
  hasUnclassified: boolean
}

/** 减仓候选：从哪只标的卖出、卖多少、大致实现盈亏 */
export interface SellCandidate {
  itemId: string
  categoryId: string
  categoryName: string
  name: string
  code?: string
  /** 可卖出的市值上限（= 该标的当前市值） */
  value: number
  /** 建议卖出金额 */
  sellAmount: number
  /** 该标的的浮动盈亏（若无成本信息则为 undefined） */
  profit?: number
  /** 按卖出比例折算的实现盈亏 */
  realizedProfit?: number
}

/** 加仓目标（钱往哪里去） */
export interface BuyTarget {
  classId: string
  name: string
  color: string
  amount: number
}

/** 组合健康度等级 */
export type HealthLevel = 'healthy' | 'watch' | 'warning' | 'critical'

export interface RebalanceResult {
  strategyId: StrategyId
  strategyName: string
  /** 用于分配的总资产（按设置决定是否扣除负债） */
  totalForAllocation: number
  /** 扣除的负债金额 */
  liabilityDeducted: number
  threshold: number
  classes: ClassRebalance[]
  /** 总偏离率 = Σ|偏离度| / 2 */
  totalDeviation: number
  /** 总偏离率的百分点形式 */
  totalDeviationPoints: number
  health: HealthLevel
  healthLabel: string
  healthHint: string
  /** 所有超配类别可提供的卖出总额 */
  sellCapacity: number
  /** 计划执行的卖出总额 */
  plannedSell: number
  /** 计划执行的买入总额 */
  plannedBuy: number
  /** 未映射到任何策略类别的分类 */
  unmappedCategories: Array<{ id: string; name: string; value: number }>
  /** 缺少行业类型信息的持仓数量 */
  unclassifiedItemCount: number
  /** 未归类的金额（不进任何桶，界面要单独列出来） */
  unclassifiedValue: number
  /** 被排除在配置之外的金额（房产 / 房贷 / 保险年金 / 分期划扣） */
  excludedValue: number
}

/** 再平衡设置（持久化） */
export interface StrategySettings {
  version: number
  /** 当前启用的策略 id */
  activeStrategyId: StrategyId
  /** 用户自定义策略 */
  customStrategies: Strategy[]
  /** 用户调整过的映射：策略 id -> 分类 id -> 映射 */
  mappings: Record<string, CategoryMapping>
  /**
   * 条目级映射（优先于分类级）：策略 id -> 标的 key -> 规则。
   * 标的 key：有代码用 `market:code`，没代码用 `id:<itemId>`（见 lib/itemMapping.ts）。
   */
  itemMappings: Record<string, ItemMapping>
  /** 触发建议的阈值（百分点，默认 5） */
  threshold: number
  /** 负债类分类的值是否计入分配总额的分母（默认 false，即按「可投资资产」算占比） */
  includeLiabilities: boolean
  /** 未映射分类的处理方式 */
  unmappedPolicy: 'auto' | 'ignore'
}
