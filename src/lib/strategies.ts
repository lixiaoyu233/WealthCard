import type { AssetSemantic, MappingEntry, Strategy, StrategyClass, StrategyId } from '../types/strategy'

/* ------------------------------------------------------------------ *
 * 内置策略
 * ------------------------------------------------------------------ */

/**
 * 预设强调色。取值是 CSS 变量的引用而不是 hex ——
 * 这样「白天主题」能自动换成对比度更高的深色版，不必改数据。
 */
export const ACCENT_NAMES = ['blue', 'green', 'gold', 'purple', 'cyan', 'orange', 'red', 'pink', 'slate'] as const
export type AccentName = (typeof ACCENT_NAMES)[number]

export const accentVar = (name: AccentName) => `var(--accent-${name})`
export const accentSoftVar = (name: AccentName) => `var(--accent-${name}-soft)`

/** 默认取色顺序（新增分类时轮换使用） */
export const CLASS_COLORS: string[] = ACCENT_NAMES.map(accentVar)

const cls = (
  id: string,
  name: string,
  target: number,
  colorName: AccentName,
  semantic?: AssetSemantic,
): StrategyClass => ({
  id,
  name,
  target,
  color: accentVar(colorName),
  colorName,
  semantic,
})

/**
 * 桥水全天候。
 *
 * 与桥水原始风险权重（股票30/长债40/中债15/黄金7.5/商品7.5）相比，
 * 这里额外拆出 **5% 现金**，其余四类按 95% 等比缩放（28.5 / 38 / 14.25 / 7.125 / 7.125），
 * 合计仍为 100%。原因：用户的「现金与固定资产」（活期、房产等）必须找得到归属，
 * 否则只能被硬塞进债券，会让偏离度完全失真。
 */
const ALL_WEATHER: Strategy = {
  id: 'all-weather',
  name: '全天候策略（桥水）',
  kind: 'builtin',
  description: '股票 28.5% / 长期国债 38% / 中期国债 14.25% / 黄金 7.13% / 大宗商品 7.13% / 现金 5%',
  classes: [
    cls('stock', '股票', 28.5, 'blue', 'stock'),
    cls('bond-long', '长期国债', 38, 'green', 'bond-long'),
    cls('bond-mid', '中期国债', 14.25, 'cyan', 'bond-mid'),
    cls('gold', '黄金', 7.125, 'gold', 'gold'),
    cls('commodity', '大宗商品', 7.125, 'orange', 'commodity'),
    cls('cash', '现金', 5, 'slate', 'cash'),
  ],
}

/** 桥水原始比例，用于在设置页展示说明 */
export const ALL_WEATHER_ORIGINAL = '股票 30% / 长期国债 40% / 中期国债 15% / 黄金 7.5% / 大宗商品 7.5%'

/** 哈利·布朗永久组合 */
const PERMANENT: Strategy = {
  id: 'permanent',
  name: '永久组合（哈利·布朗）',
  kind: 'builtin',
  // 用户口径：这一类改叫「国债」，长期/中期的国债都并进来（id 保持 bond-long，兼容老数据）
  description: '股票 25% / 国债 25% / 黄金 25% / 现金 25%',
  classes: [
    cls('stock', '股票', 25, 'blue', 'stock'),
    cls('bond-long', '国债', 25, 'green', 'bond'),
    cls('gold', '黄金', 25, 'gold', 'gold'),
    cls('cash', '现金', 25, 'slate', 'cash'),
  ],
}

/** 经典 60/40 */
const CLASSIC_60_40: Strategy = {
  id: 'classic-60-40',
  name: '经典 60/40',
  kind: 'builtin',
  description: '股票 60% / 债券 40%（黄金与现金并入债券）',
  classes: [cls('stock', '股票', 60, 'blue', 'stock'), cls('bond', '债券', 40, 'green', 'bond')],
}

export const BUILTIN_STRATEGIES: Strategy[] = [ALL_WEATHER, PERMANENT, CLASSIC_60_40]

export const DEFAULT_STRATEGY_ID: StrategyId = 'all-weather'

export function findBuiltinStrategy(id: StrategyId): Strategy | undefined {
  return BUILTIN_STRATEGIES.find((s) => s.id === id)
}

/** 深拷贝，避免把内置常量对象交给 UI 后又被就地修改 */
export function cloneStrategy(s: Strategy): Strategy {
  return { ...s, classes: s.classes.map((c) => ({ ...c })) }
}

/* ------------------------------------------------------------------ *
 * 默认映射
 * ------------------------------------------------------------------ *
 * 每个分类给一个「主类别」+ 可选拆分。做成每种策略一份的原因：
 * 策略里的类别名字不同（有「长期国债」就没有「债券」），必须按策略分别指定。
 * 匹配不到的 key 会自动回退（见 rebalance.ts 的 resolveMapping）。
 */

const single = (strategyClassId: string): MappingEntry[] => [{ strategyClassId, percent: 100 }]

export const DEFAULT_MAPPINGS: Record<StrategyId, Record<string, MappingEntry[]>> = {
  'all-weather': {
    cat_cash: single('cash'),
    cat_stock: single('stock'),
    // 基金默认当作股票；能穿透到占比的会按占比拆进各桶
    cat_fund: single('stock'),
    cat_gold: single('gold'),
    // 国债：默认按中期，条目上选了「长期」的会走 bond-long
    cat_bond: single('bond-mid'),
    // 负债按「负的现金」计入（见 rebalance.ts），这里只是文档化
    cat_debt: single('cash'),
  },
  permanent: {
    cat_cash: single('cash'),
    cat_stock: single('stock'),
    cat_fund: single('stock'),
    cat_gold: single('gold'),
    cat_bond: single('bond-long'),
    cat_debt: single('bond-long'),
  },
  // 用户口径：60/40 只有两个桶，黄金与现金都并入债券
  'classic-60-40': {
    cat_cash: single('bond'),
    cat_stock: single('stock'),
    cat_fund: single('stock'),
    cat_gold: single('bond'),
    cat_bond: single('bond'),
    cat_debt: single('bond'),
  },
}

/** 自定义分类（用户以后新建的）按名称关键词猜测归属类别 */
export const CATEGORY_KEYWORD_RULES: Array<{ match: RegExp; classIds: string[] }> = [
  // 注意别把「数字货币」误判成现金：只认明确的现金/存款字样
  { match: /(现金|存款|活期|余额宝|货币基金|银行理财)/, classIds: ['cash', 'bond', 'bond-mid'] },
  { match: /(股|权益|指数|ETF)/i, classIds: ['stock'] },
  { match: /(国债|债券|固收|债)/, classIds: ['bond', 'bond-long', 'bond-mid'] },
  { match: /(黄金|金|贵金属)/, classIds: ['gold'] },
  { match: /(商品|大宗|原油|农产品)/, classIds: ['commodity'] },
  { match: /(房|地产|不动产|车)/, classIds: ['stock', 'commodity'] },
  { match: /(负债|贷款|信用卡|借款)/, classIds: ['bond', 'bond-long', 'bond-mid'] },
]

/** 策略类别 id 之间的同义关系，用于在策略间切换时复用映射 */
export const CLASS_EQUIVALENTS: Record<string, string[]> = {
  bond: ['bond-long', 'bond-mid', 'cash'],
  'bond-long': ['bond', 'bond-mid'],
  'bond-mid': ['bond', 'bond-long'],
  cash: ['bond', 'bond-mid'],
  stock: ['stock'],
  gold: ['gold'],
  commodity: ['commodity'],
}

/** 校验策略目标比例合计是否为 100（允许 0.01 的浮点误差） */
export function strategyTotal(strategy: Strategy): number {
  return strategy.classes.reduce((sum, c) => sum + (Number.isFinite(c.target) ? c.target : 0), 0)
}

export function isStrategyValid(strategy: Strategy): { ok: boolean; total: number; message?: string } {
  const total = strategyTotal(strategy)
  const rounded = Math.round(total * 100) / 100
  if (strategy.classes.length === 0) return { ok: false, total, message: '至少需要 1 个资产类别' }
  if (Math.abs(rounded - 100) > 0.01) {
    return {
      ok: false,
      total,
      message: `目标比例合计需为 100%，当前为 ${rounded}%`,
    }
  }
  return { ok: true, total }
}

/** 生成一个新的空自定义策略 */
export function createCustomStrategy(name = '我的策略', description = '自定义目标比例'): Strategy {
  return {
    id: `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    kind: 'custom',
    description,
    classes: [
      { id: 'stock', name: '股票', target: 50, color: accentVar('blue'), colorName: 'blue' },
      { id: 'bond', name: '债券', target: 50, color: accentVar('green'), colorName: 'green' },
    ],
  }
}

/** 按 id 找类别（找不到返回 undefined） */
export function findClass(strategy: Strategy, classId: string): StrategyClass | undefined {
  return strategy.classes.find((c) => c.id === classId)
}
