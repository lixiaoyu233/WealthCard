/**
 * 资产占比（穿透）——把一笔持仓看成「股票/债券/现金/黄金/大宗商品/其他」的占比向量。
 *
 * 为什么不用单一类别：混合基金、二级债基、黄金 ETF 本身就是混合的，
 * 整笔算成"股票"会让偏离度失真（实测：华夏成长 股 80/债 20、二级债基 股 19/债 92.5）。
 *
 * 数据来源（优先级）：用户手动 > 东财资产配置接口（中国上市基金/ETF 可拉）> 名称关键词 > 固定形态
 */
import type {
  AssetMix,
  AssetSemantic,
  MappingEntry,
  Strategy,
  StrategyClass,
} from '../types/strategy'

export const ZERO_MIX: AssetMix = { equity: 0, bond: 0, money: 0, gold: 0, commodity: 0, other: 0 }

export const mixOf = (parts: Array<AssetMix | undefined>): AssetMix => {
  const out: AssetMix = { ...ZERO_MIX }
  for (const p of parts) {
    if (!p) continue
    out.equity += p.equity
    out.bond += p.bond
    out.money += p.money
    out.gold += p.gold
    out.commodity += p.commodity
    out.other += p.other
  }
  return out
}

export const mixTotal = (mix: AssetMix): number =>
  mix.equity + mix.bond + mix.money + mix.gold + mix.commodity + mix.other

export const mixIsEmpty = (mix: AssetMix | undefined): boolean => !mix || mixTotal(mix) <= 0.0001

export const scaleMix = (mix: AssetMix, k: number): AssetMix => ({
  equity: mix.equity * k,
  bond: mix.bond * k,
  money: mix.money * k,
  gold: mix.gold * k,
  commodity: mix.commodity * k,
  other: mix.other * k,
})

/**
 * 归一化：负数截 0，按合计缩放到 1。
 * 必须做——基金「占净比」用的是净值做分母、分子含杠杆，实测有债券占净比 107%/118% 的情况。
 */
export function normalizeMix(raw: Partial<AssetMix> | null | undefined): AssetMix {
  if (!raw) return { ...ZERO_MIX }
  const clean = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  const mix: AssetMix = {
    equity: clean(raw.equity),
    bond: clean(raw.bond),
    money: clean(raw.money),
    gold: clean(raw.gold),
    commodity: clean(raw.commodity),
    other: clean(raw.other),
  }
  const total = mixTotal(mix)
  if (total <= 0) return { ...ZERO_MIX }
  return scaleMix(mix, 1 / total)
}

/* ------------------------------------------------------------------ *
 * 固定形态
 * ------------------------------------------------------------------ */

export const mixForStock = (): AssetMix => ({ ...ZERO_MIX, equity: 1 })
export const mixForGold = (): AssetMix => ({ ...ZERO_MIX, gold: 1 })
export const mixForCash = (): AssetMix => ({ ...ZERO_MIX, money: 1 })

/* ------------------------------------------------------------------ *
 * 名称兜底（拉不到接口数据时用，界面上会标为「推测」）
 * ------------------------------------------------------------------ */

export function mixFromName(name: string | undefined, market?: string): AssetMix | undefined {
  const n = (name ?? '').trim()
  if (!n) return undefined
  // 货币 / 现金管理
  if (/(货币|现金宝|活期宝|理财金|添益|保证金)/.test(n)) return mixForCash()
  // 黄金 / 贵金属
  if (/(黄金|贵金属|白银|金ETF)/.test(n)) return mixForGold()
  // 其他商品
  if (/(原油|豆粕|有色|能源化工|商品|饲料|农业期货)/.test(n)) return { ...ZERO_MIX, commodity: 1 }
  // 可转债 / 债券 / 固收
  if (/(可转债|转债|债券|纯债|短债|中短债|信用债|利率债|国债|城投债|固收|债基)/.test(n)) {
    return { ...ZERO_MIX, bond: 1 }
  }
  // 混合：给一个折中拆分，比整笔算股票更接近事实
  if (/(混合|灵活配置|平衡|稳健|养老目标|绝对收益)/.test(n)) {
    return { ...ZERO_MIX, equity: 0.6, bond: 0.4 }
  }
  // 股票 / 指数 / 海外
  if (
    /(股票|指数|ETF|LOF|联接|增强|成长|价值|红利|消费|医药|科技|新能源|半导体|军工|券商|银行|地产|白酒|沪深|中证|标普|纳斯达克|恒生|MSCI|海外|全球|QDII)/i.test(
      n,
    )
  ) {
    return mixForStock()
  }
  // 美股上市 ETF（无接口数据）默认整笔算股票，用户可手改
  if (market === 'us' || market === 'hk') return mixForStock()
  return undefined
}

/**
 * 从名称里猜债券久期：只有明确的期限字样才认（宁可不猜，也不要猜错）。
 * 例：30年国债ETF / 超长债 → 长期；中短债 / 1-3年 → 中期（我们的默认就是这个，返回 undefined 即可）
 */
export function inferBondTerm(name: string | undefined): 'long' | 'mid' | undefined {
  const n = (name ?? '').trim()
  if (!n) return undefined
  if (/(10年|十年|15年|20年|30年|三十年|长久期|超长期|长债|长期国债|长期纯债)/.test(n)) return 'long'
  if (/(短债|超短|中短|1-3年|0-3年|短期纯债)/.test(n)) return 'mid'
  return undefined
}

/* ------------------------------------------------------------------ *
 * 东财资产配置 → 占比
 * ------------------------------------------------------------------ */

export interface AllocationRow {
  /** 报告期 */
  FSRQ?: string
  /** 股票占净比 */
  GP?: string
  /** 债券占净比 */
  ZQ?: string
  /** 现金（银行存款/备付金）占净比 */
  HB?: string
  /** 其他占净比 */
  QT?: string
}

/** 接口里的 '--' / '' / null 都表示没有数据 */
export function parsePct(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  if (!s || s === '--' || s === '-') return undefined
  const n = Number(s.replace(/[%％]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * 资产配置占比 → 资产占比。
 *
 * 两条实测得到的特例：
 * 1. 货币基金显示「债券 50.68%」其实是同业存单 → 类型含「货币型」直接算 100% 现金
 * 2. 黄金/商品 ETF 的资产几乎全落在「其他」里（实测 518880 其他 99.61%）→ 靠类型+名称判成黄金/商品
 */
export function mixFromAllocation(
  row: AllocationRow | undefined,
  opts: { ftype?: string; name?: string } = {},
): AssetMix | undefined {
  if (!row) return undefined
  const gp = parsePct(row.GP)
  const zq = parsePct(row.ZQ)
  const hb = parsePct(row.HB)
  const qt = parsePct(row.QT)
  if (gp === undefined && zq === undefined && hb === undefined && qt === undefined) return undefined

  const ftype = (opts.ftype ?? '').trim()
  const name = opts.name ?? ''
  if (/货币型/.test(ftype)) return mixForCash()

  const raw: AssetMix = {
    equity: gp ?? 0,
    bond: zq ?? 0,
    money: hb ?? 0,
    gold: 0,
    commodity: 0,
    other: qt ?? 0,
  }
  // 「其他」占绝对多数时，多数是黄金/商品（或 REITs 之类），用名称再判一次
  const total = mixTotal(raw)
  if (total > 0 && raw.other / total > 0.8) {
    const byName = mixFromName(name)
    if (byName && (byName.gold > 0 || byName.commodity > 0 || byName.money > 0)) return byName
  }
  return normalizeMix(raw)
}

/* ------------------------------------------------------------------ *
 * 资产占比 → 策略桶
 * ------------------------------------------------------------------ */

const ID_SEMANTIC: Record<string, AssetSemantic> = {
  stock: 'stock',
  bond: 'bond',
  'bond-long': 'bond-long',
  'bond-mid': 'bond-mid',
  cash: 'cash',
  gold: 'gold',
  commodity: 'commodity',
  other: 'other',
}

/** 策略类别的语义：显式字段优先，其次按 id、最后按名称关键词 */
export function semanticOfClass(cls: StrategyClass): AssetSemantic | undefined {
  if (cls.semantic) return cls.semantic
  const byId = ID_SEMANTIC[cls.id]
  if (byId) return byId
  const n = cls.name
  if (/长期.*债|长债/.test(n)) return 'bond-long'
  if (/中(短|期).*债|短债|中期国债/.test(n)) return 'bond-mid'
  if (/债|固收/.test(n)) return 'bond'
  if (/现金|货币|活期/.test(n)) return 'cash'
  if (/黄金|贵金属/.test(n)) return 'gold'
  if (/商品|大宗|原油/.test(n)) return 'commodity'
  if (/股|权益|指数/.test(n)) return 'stock'
  if (/其他/.test(n)) return 'other'
  return undefined
}

/**
 * 策略对某语义的"兜底去处"（策略里没有这个桶时）。
 * 用户口径：60/40 里黄金与现金都并入债券；永久组合没有大宗商品桶，并进黄金。
 */
export const STRATEGY_SPILL: Record<string, Partial<Record<AssetSemantic, AssetSemantic>>> = {
  'classic-60-40': { cash: 'bond', gold: 'bond', commodity: 'bond' },
  permanent: { commodity: 'gold' },
}

/**
 * 没给期限时的债券兜底顺序：优先通用「债券」桶，其次「中期国债」。
 * 选中期而不是长期是刻意的默认（更保守）；要长债就在条目上把期限选成「长期」。
 */
const BOND_FALLBACK: AssetSemantic[] = ['bond', 'bond-mid', 'bond-long']

/** 找到该语义最终落到的语义（可能是兜底后的） */
export function resolveSemantic(
  want: AssetSemantic,
  strategy: Strategy,
  has: (s: AssetSemantic) => boolean,
): AssetSemantic | undefined {
  if (has(want)) return want
  const spill = STRATEGY_SPILL[String(strategy.id)]?.[want]
  if (spill && has(spill)) return spill
  // 债券三兄弟互相兜底
  if (want === 'bond' || want === 'bond-long' || want === 'bond-mid') {
    const hit = BOND_FALLBACK.find((s) => s !== want && has(s))
    if (hit) return hit
  }
  // 黄金与商品互相兜底
  if (want === 'gold' && has('commodity')) return 'commodity'
  if (want === 'commodity' && has('gold')) return 'gold'
  return undefined
}

export interface MixToEntriesOptions {
  /** 国债期限：决定落「长期国债」还是「中期国债」 */
  bondTerm?: 'long' | 'mid'
}

/**
 * 把资产占比落到策略桶，返回百分比 MappingEntry[]。
 * 落不进去的部分（例如策略里没有"其他"桶）不会静默并进别的桶 —— 由调用方算作「未归类」。
 */
export function mixToEntries(mix: AssetMix, strategy: Strategy, options: MixToEntriesOptions = {}): MappingEntry[] {
  const bySemantic = new Map<AssetSemantic, string>()
  for (const cls of strategy.classes) {
    const s = semanticOfClass(cls)
    if (s && !bySemantic.has(s)) bySemantic.set(s, cls.id)
  }
  const has = (s: AssetSemantic) => bySemantic.has(s)
  const out = new Map<string, number>()
  const add = (semantic: AssetSemantic, percent: number) => {
    if (percent <= 0) return
    const id = bySemantic.get(semantic)
    if (!id) return
    out.set(id, (out.get(id) ?? 0) + percent)
  }

  // 债券：有期限按期限，没期限时优先通用「债券」桶，其次长债、中债
  const bondSemantic: AssetSemantic =
    options.bondTerm === 'long' ? 'bond-long' : options.bondTerm === 'mid' ? 'bond-mid' : 'bond'

  const wants: Array<[keyof AssetMix, AssetSemantic]> = [
    ['equity', 'stock'],
    ['bond', bondSemantic],
    ['money', 'cash'],
    ['gold', 'gold'],
    ['commodity', 'commodity'],
    ['other', 'other'],
  ]
  for (const [key, want] of wants) {
    const percent = mix[key] * 100
    if (percent <= 0) continue
    const resolved = resolveSemantic(want, strategy, has)
    if (!resolved) continue // 未归类：交给上层明确展示
    add(resolved, percent)
  }
  return [...out.entries()].map(([strategyClassId, percent]) => ({ strategyClassId, percent }))
}

/** 某笔资产占比里"落不进任何桶"的比例（0~1），用于提示「未归类」 */
export function unclassifiedRatio(mix: AssetMix, strategy: Strategy, options: MixToEntriesOptions = {}): number {
  const entries = mixToEntries(mix, strategy, options)
  const placed = entries.reduce((sum, e) => sum + e.percent, 0) / 100
  return Math.max(0, Math.min(1, mixTotal(mix) - placed))
}
