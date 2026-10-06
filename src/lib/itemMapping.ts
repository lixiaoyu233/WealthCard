/**
 * 条目级映射：把「某一笔资产」落到策略桶上。
 *
 * 优先级（高 → 低）：
 *   1. 排除规则（条目/分类名带「房」、保险/年金分类、分期划扣维护的条目）
 *   2. 条目级手动规则（手动指定桶 / 手动占比 / 国债期限）
 *   3. 条目级自动识别（穿透占比 → 策略桶；形态兜底：个股=股票、积存金=黄金）
 *   4. 分类级映射（用户手填 or 内置默认/关键词兜底）
 *   5. 都没有 → 「未归类」（明确暴露，绝不静默并进别的桶）
 *
 * key 用「标的身份」：有代码用 `market:code`，没代码用 `id:<itemId>`。
 */
import type { AssetItem, Category } from '../types/asset'
import type { AssetMix, ItemMapping, ItemMappingRule, MappingEntry, Strategy } from '../types/strategy'
import { isFund } from './calc'
import {
  ZERO_MIX,
  inferBondTerm,
  mixForCash,
  mixForGold,
  mixForStock,
  mixFromName,
  mixToEntries,
  normalizeMix,
  type MixToEntriesOptions,
} from './assetMix'

/** 带「房」的一律不纳入配置（用户口径） */
export const PROPERTY_KEYWORD = /房/
/** 保险 / 年金 / 保障类：属于非投资资产，默认不纳入配置 */
export const PROTECTION_KEYWORD = /保险|年金|保障|社保|公积金/

/** 标的身份：有代码 → market:code；没代码 → id:<itemId> */
export function itemKeyOf(item: AssetItem): string {
  if (isFund(item)) {
    const code = (item.code ?? '').trim()
    if (code) return `${item.market ?? 'cn'}:${code.toUpperCase()}`
  }
  return `id:${item.id}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function normalizeEntries(raw: unknown): MappingEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: MappingEntry[] = []
  for (const e of raw) {
    if (!isRecord(e)) continue
    const id = typeof e.strategyClassId === 'string' ? e.strategyClassId : ''
    const percent = Number(e.percent)
    if (!id || !Number.isFinite(percent) || percent <= 0) continue
    out.push({ strategyClassId: id, percent })
  }
  return out.length ? out : undefined
}

function normalizeRule(raw: unknown): ItemMappingRule | null {
  if (!isRecord(raw)) return null
  const rule: ItemMappingRule = {}
  const entries = normalizeEntries(raw.entries)
  if (entries) rule.entries = entries
  if (isRecord(raw.mix)) rule.mix = normalizeMix(raw.mix as Partial<AssetMix>)
  if (raw.bondTerm === 'long' || raw.bondTerm === 'mid') rule.bondTerm = raw.bondTerm
  if (raw.excluded === true) rule.excluded = true
  if (raw.source === 'manual' || raw.source === 'auto') rule.source = raw.source
  if (Number.isFinite(Number(raw.updatedAt))) rule.updatedAt = Number(raw.updatedAt)
  return Object.keys(rule).length ? rule : null
}

export function normalizeItemMapping(raw: unknown): ItemMapping {
  if (!isRecord(raw)) return {}
  const out: ItemMapping = {}
  for (const [key, value] of Object.entries(raw)) {
    const rule = normalizeRule(value)
    if (rule && key) out[key] = rule
  }
  return out
}

/** 分类是否属于「不纳入配置」（保险/年金、名称带房） */
export function isExcludedCategory(category: Category): boolean {
  if (PROPERTY_KEYWORD.test(category.name)) return true
  return PROTECTION_KEYWORD.test(category.name)
}

/** 条目是否属于「不纳入配置」 */
export function isExcludedItem(item: AssetItem, category: Category): boolean {
  if (isExcludedCategory(category)) return true
  return PROPERTY_KEYWORD.test(item.name ?? '')
}

/**
 * 形态兜底占比：不依赖任何网络数据。
 * - 积存金（形态 gold）→ 黄金
 * - 有市场的持仓（A股/港股/美股个股）→ 股票
 * - 金额类条目：按分类名判断（现金/债/黄金…），判不出返回 undefined 交给分类映射
 */
export function shapeMix(item: AssetItem, category: Category): AssetMix | undefined {
  if (item.kind === 'gold') return mixForGold()
  if (isFund(item)) {
    const market = item.market ?? 'cn'
    // 场外基金要靠穿透/名称；个股（A股/港股/美股）本身就是股票
    if (market === 'ashare' || market === 'hk' || market === 'us') return mixForStock()
    return undefined
  }
  const cname = category.name
  if (PROPERTY_KEYWORD.test(cname)) return undefined
  if (/现金|存款|活期|余额宝|货币基金|银行理财/.test(cname)) return mixForCash()
  if (/黄金|贵金属/.test(cname)) return mixForGold()
  if (/债|固收/.test(cname)) return { equity: 0, bond: 1, money: 0, gold: 0, commodity: 0, other: 0 }
  if (/商品|大宗/.test(cname)) return { equity: 0, bond: 0, money: 0, gold: 0, commodity: 1, other: 0 }
  return undefined
}

export type MappingSource = 'manual-item' | 'auto' | 'category' | 'unmapped'

export interface ResolvedItemMapping {
  entries: MappingEntry[]
  source: MappingSource
  /** 自动识别用到的资产占比（有的话） */
  mix?: AssetMix
  excluded: boolean
  bondTerm?: 'long' | 'mid'
  /** 该条目自动识别用到的语义来源（穿透 / 形态 / 名称推测） */
  mixOrigin?: 'api' | 'name' | 'shape' | 'manual'
  /** 落不进任何桶的比例（0~1），>0 时界面提示「未归类」 */
  unclassified?: number
}

export interface ResolveItemMappingInput {
  item: AssetItem
  category: Category
  strategy: Strategy
  /** 用户设置过的条目级规则 */
  itemMapping?: ItemMapping
  /** 已经算好的分类级映射（用户手填 > 内置默认 > 关键词兜底） */
  categoryEntries?: MappingEntry[]
  /** 自动识别得到的资产占比（穿透结果或名称推测） */
  autoMix?: AssetMix
  autoMixOrigin?: 'api' | 'name'
  /** 明确排除的条目 id（例如由「定期划扣」计划维护的负债条目） */
  excludedItemIds?: string[]
  /** 国债期限（条目上选的，缺省用规则里的） */
  bondTerm?: 'long' | 'mid'
}

/** 解析一笔资产最终落到哪些桶 */
export function resolveItemMapping(input: ResolveItemMappingInput): ResolvedItemMapping {
  const { item, category, strategy, itemMapping, categoryEntries, autoMix, autoMixOrigin, excludedItemIds } = input
  const key = itemKeyOf(item)
  const rule = itemMapping?.[key]

  // 1) 排除
  if (rule?.excluded === true || isExcludedItem(item, category) || excludedItemIds?.includes(item.id)) {
    return { entries: [], source: 'unmapped', excluded: true, bondTerm: rule?.bondTerm ?? input.bondTerm }
  }

  // 期限优先级：条目级规则 > 条目字段 > 名称线索（30年国债ETF 这类）
  const bondTerm = rule?.bondTerm ?? input.bondTerm ?? inferBondTerm(item.name)
  const opts: MixToEntriesOptions = { bondTerm }

  // 2) 条目级手动
  if (rule?.entries?.length) {
    return { entries: rule.entries, source: 'manual-item', excluded: false, bondTerm, mixOrigin: 'manual' }
  }
  if (rule?.mix) {
    const mix = normalizeMix(rule.mix)
    const entries = mixToEntries(mix, strategy, opts)
    return { entries, source: 'manual-item', excluded: false, mix, mixOrigin: 'manual', bondTerm }
  }

  // 2.5) 旧数据兼容：基金条目上的人工资产类型标记（assetClass）当成手动占比
  if (isFund(item) && item.assetClass) {
    const legacy = ruleFromLegacyAssetClass(item.assetClass)
    if (legacy?.mix) {
      const mix = normalizeMix(legacy.mix)
      return {
        entries: mixToEntries(mix, strategy, opts),
        source: 'manual-item',
        excluded: false,
        mix,
        mixOrigin: 'manual',
        bondTerm,
      }
    }
  }

  // 3) 条目级自动识别：穿透占比 > 形态（个股/积存金/分类语义）> 基金名称关键词
  const shape = shapeMix(item, category)
  const nameMix = !shape && isFund(item) ? mixFromName(item.name, item.market) : undefined
  const mix = autoMix ?? shape ?? nameMix
  if (mix && !(mix.equity + mix.bond + mix.money + mix.gold + mix.commodity + mix.other <= 0)) {
    const norm = normalizeMix(mix)
    const entries = mixToEntries(norm, strategy, opts)
    const placed = entries.reduce((sum, e) => sum + e.percent, 0) / 100
    return {
      entries,
      source: 'auto',
      mix: norm,
      excluded: false,
      bondTerm,
      mixOrigin: autoMix ? (autoMixOrigin ?? 'name') : shape ? 'shape' : 'name',
      unclassified: Math.max(0, 1 - placed),
    }
  }

  // 4) 分类级映射
  if (categoryEntries?.length) {
    return { entries: categoryEntries, source: 'category', excluded: false, bondTerm }
  }

  // 5) 未归类
  return { entries: [], source: 'unmapped', excluded: false, bondTerm }
}

/** 界面展示用：这笔资产当前的映射来源文案 */
export function mappingSourceLabel(m: ResolvedItemMapping): string {
  if (m.excluded) return '不纳入配置'
  if (m.source === 'manual-item') return '手动设置'
  if (m.source === 'category') return '按分类映射'
  if (m.source === 'unmapped') return '未归类'
  if (m.mixOrigin === 'api') return '自动·穿透'
  if (m.mixOrigin === 'name') return '自动·名称推测'
  return '自动·形态'
}

/**
 * 旧数据迁移：把基金条目上的 `assetClass`（单值）转成新规则的占比。
 * 只在用户没设过新规则时使用，保留人工标记的意图。
 */
export function ruleFromLegacyAssetClass(assetClass: string | undefined): ItemMappingRule | undefined {
  switch (assetClass) {
    case 'equity':
      return { mix: mixForStock(), source: 'manual' }
    case 'bond':
      return { mix: { ...ZERO_MIX, bond: 1 }, source: 'manual' }
    case 'money':
      return { mix: mixForCash(), source: 'manual' }
    case 'commodity':
      return { mix: mixForGold(), source: 'manual' }
    default:
      return undefined
  }
}
