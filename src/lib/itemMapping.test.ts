import { describe, expect, it } from 'vitest'
import type { AssetItem, Category } from '../types/asset'
import { BUILTIN_STRATEGIES } from './strategies'
import { ZERO_MIX } from './assetMix'
import {
  isExcludedCategory,
  isExcludedItem,
  itemKeyOf,
  mappingSourceLabel,
  normalizeItemMapping,
  resolveItemMapping,
  ruleFromLegacyAssetClass,
  shapeMix,
} from './itemMapping'

const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!

const cat = (id: string, name: string, extra: Partial<Category> = {}): Category => ({
  id,
  name,
  subtitle: '',
  icon: 'x',
  color: 'x',
  items: [],
  ...extra,
})

const cashCat = cat('cat_cash', '现金与固定资产')
const stockCat = cat('cat_stock', '股票')
const fundCat = cat('cat_fund', '基金')
const bondCat = cat('cat_bond', '国债')
const insuranceCat = cat('cat_insurance', '保险与年金')

const amount = (id: string, name: string, value = 1000, extra: Record<string, unknown> = {}): AssetItem =>
  ({ id, kind: 'amount', name, amount: value, ...extra }) as AssetItem
const fund = (id: string, name: string, code = '161725', market = 'cn'): AssetItem =>
  ({ id, kind: 'fund', name, code, shares: 100, costNav: 1, market }) as AssetItem

describe('itemKeyOf：用「标的身份」而不是条目 id', () => {
  it('有代码 → market:CODE（大写）', () => {
    expect(itemKeyOf(fund('f1', '贵州茅台', '600519', 'ashare'))).toBe('ashare:600519')
    expect(itemKeyOf(fund('f2', 'spy', 'spy', 'us'))).toBe('us:SPY')
  })
  it('没有代码 → id:<itemId>', () => {
    expect(itemKeyOf(amount('a1', '招行活期'))).toBe('id:a1')
  })
})

describe('normalizeItemMapping：脏数据兜底', () => {
  it('非法条目被丢弃，合法字段保留', () => {
    const m = normalizeItemMapping({
      'ashare:510300': { entries: [{ strategyClassId: 'stock', percent: 40 }, { strategyClassId: '', percent: 0 }], bondTerm: 'long' },
      bad: null,
      'id:x': { excluded: true },
    })
    expect(Object.keys(m).sort()).toEqual(['ashare:510300', 'id:x'])
    expect(m['ashare:510300'].entries).toEqual([{ strategyClassId: 'stock', percent: 40 }])
    expect(m['ashare:510300'].bondTerm).toBe('long')
    expect(m['id:x'].excluded).toBe(true)
  })
  it('不是对象 → 空映射', () => {
    expect(normalizeItemMapping(null)).toEqual({})
    expect(normalizeItemMapping('x')).toEqual({})
  })
})

describe('排除规则（用户口径）', () => {
  it('带「房」的分类与条目都不纳入配置', () => {
    expect(isExcludedCategory(cat('c', '自住房'))).toBe(true)
    expect(isExcludedItem(amount('a1', '自住房'), cashCat)).toBe(true)
    expect(isExcludedItem(amount('a2', '招行活期'), cashCat)).toBe(false)
  })
  it('保险 / 年金 / 保障类不纳入配置', () => {
    expect(isExcludedCategory(insuranceCat)).toBe(true)
    expect(isExcludedCategory(cat('c', '社保公积金'))).toBe(true)
    expect(isExcludedCategory(stockCat)).toBe(false)
  })
})

describe('shapeMix：不依赖网络数据的形态兜底', () => {
  it('积存金 → 黄金；A股/港股/美股持仓 → 股票', () => {
    expect(shapeMix({ id: 'g', kind: 'gold', name: '积存金', grams: 1, pricePerGram: 1 }, cat('c', '黄金'))!.gold).toBe(1)
    expect(shapeMix(fund('s1', '茅台', '600519', 'ashare'), stockCat)!.equity).toBe(1)
    expect(shapeMix(fund('s2', 'SPY', 'SPY', 'us'), stockCat)!.equity).toBe(1)
  })
  it('场外基金交给穿透/名称（形态判不出）', () => {
    expect(shapeMix(fund('f1', '招商白酒'), fundCat)).toBeUndefined()
  })
  it('金额类条目按分类名判断', () => {
    expect(shapeMix(amount('a1', '活期'), cashCat)!.money).toBe(1)
    expect(shapeMix(amount('a2', '国债'), bondCat)!.bond).toBe(1)
    expect(shapeMix(amount('a3', '某某理财'), cat('c', '其他理财'))).toBeUndefined()
  })
})

describe('resolveItemMapping：优先级链', () => {
  const base = {
    item: amount('a1', '招行活期'),
    category: cashCat,
    strategy: aw,
    categoryEntries: [{ strategyClassId: 'cash', percent: 100 }],
  }

  it('1) 排除优先：条目名带房 / 分类是保险 / 在 excludedItemIds 里', () => {
    expect(resolveItemMapping({ ...base, item: amount('a1', '自住房') }).excluded).toBe(true)
    expect(resolveItemMapping({ ...base, category: insuranceCat }).excluded).toBe(true)
    expect(resolveItemMapping({ ...base, excludedItemIds: ['a1'] }).excluded).toBe(true)
  })

  it('2) 条目手动指定桶优先于一切自动识别', () => {
    const r = resolveItemMapping({
      ...base,
      itemMapping: { 'id:a1': { entries: [{ strategyClassId: 'bond-mid', percent: 60 }, { strategyClassId: 'cash', percent: 40 }] } },
      autoMix: { ...ZERO_MIX, equity: 1 },
    })
    expect(r.source).toBe('manual-item')
    expect(r.entries).toEqual([
      { strategyClassId: 'bond-mid', percent: 60 },
      { strategyClassId: 'cash', percent: 40 },
    ])
  })

  it('3) 条目手动占比（可自行分割，如某 ETF 40% 股 / 60% 债）', () => {
    const r = resolveItemMapping({
      ...base,
      item: fund('f1', '某ETF', '510300', 'ashare'),
      itemMapping: { 'ashare:510300': { mix: { ...ZERO_MIX, equity: 0.4, bond: 0.6 } } },
    })
    expect(r.source).toBe('manual-item')
    expect(Object.fromEntries(r.entries.map((e) => [e.strategyClassId, e.percent]))).toEqual({
      stock: 40,
      'bond-mid': 60,
    })
  })

  it('4) 旧数据兼容：基金上的 assetClass 人工标记仍然生效', () => {
    const item = { ...fund('f1', '易方达纯债', '000001'), assetClass: 'bond' } as AssetItem
    const r = resolveItemMapping({ ...base, item, category: fundCat })
    expect(r.source).toBe('manual-item')
    expect(r.mixOrigin).toBe('manual')
    expect(Object.fromEntries(r.entries.map((e) => [e.strategyClassId, e.percent]))).toEqual({ 'bond-mid': 100 })
  })

  it('5) 穿透占比优先于名称与形态', () => {
    const r = resolveItemMapping({
      ...base,
      item: fund('f1', '招商白酒', '161725', 'cn'),
      category: fundCat,
      autoMix: { ...ZERO_MIX, equity: 0.8, bond: 0.2 },
      autoMixOrigin: 'api',
    })
    expect(r.source).toBe('auto')
    expect(r.mixOrigin).toBe('api')
  })

  it('6) 没有穿透数据时用名称推测（基金）', () => {
    const r = resolveItemMapping({ ...base, item: fund('f1', '易方达纯债债券A'), category: fundCat })
    expect(r.source).toBe('auto')
    expect(r.mixOrigin).toBe('name')
  })

  it('7) 都没有时回退分类级映射', () => {
    const r = resolveItemMapping({
      ...base,
      item: amount('a1', '某某理财'),
      category: cat('c', '其他理财'),
      categoryEntries: [{ strategyClassId: 'gold', percent: 100 }],
    })
    expect(r.source).toBe('category')
    expect(r.entries).toEqual([{ strategyClassId: 'gold', percent: 100 }])
  })

  it('8) 连分类映射都没有 → 未归类（不静默并进别的桶）', () => {
    const r = resolveItemMapping({
      ...base,
      item: amount('a1', '某某理财'),
      category: cat('c', '其他理财'),
      categoryEntries: undefined,
    })
    expect(r.source).toBe('unmapped')
    expect(r.entries).toEqual([])
    expect(r.excluded).toBe(false)
  })
})

describe('展示文案与旧数据迁移', () => {
  it('来源文案', () => {
    expect(mappingSourceLabel({ entries: [], source: 'unmapped', excluded: true })).toBe('不纳入配置')
    expect(mappingSourceLabel({ entries: [], source: 'manual-item', excluded: false })).toBe('手动设置')
    expect(mappingSourceLabel({ entries: [], source: 'category', excluded: false })).toBe('按分类映射')
    expect(mappingSourceLabel({ entries: [], source: 'unmapped', excluded: false })).toBe('未归类')
    expect(mappingSourceLabel({ entries: [], source: 'auto', excluded: false, mixOrigin: 'api' })).toBe('自动·穿透')
    expect(mappingSourceLabel({ entries: [], source: 'auto', excluded: false, mixOrigin: 'name' })).toBe('自动·名称推测')
  })

  it('ruleFromLegacyAssetClass：equity/bond/money/commodity → 占比', () => {
    expect(ruleFromLegacyAssetClass('equity')!.mix!.equity).toBe(1)
    expect(ruleFromLegacyAssetClass('bond')!.mix!.bond).toBe(1)
    expect(ruleFromLegacyAssetClass('money')!.mix!.money).toBe(1)
    expect(ruleFromLegacyAssetClass('commodity')!.mix!.gold).toBe(1)
    expect(ruleFromLegacyAssetClass('mixed')).toBeUndefined()
    expect(ruleFromLegacyAssetClass(undefined)).toBeUndefined()
  })
})


describe('美股 ETF 的自动识别：预设/名称优先于「形态一律算股票」', () => {
  const usFund = (name: string, code: string): AssetItem =>
    ({ id: 'u1', kind: 'fund', name, code, market: 'us', shares: 100, costNav: 1 }) as AssetItem

  it('BND（总债券市场 ETF）→ 债券桶，来自内置预设', () => {
    const r = resolveItemMapping({
      item: usFund('Vanguard Total Bond Market ETF', 'BND'),
      category: stockCat,
      strategy: aw,
      categoryEntries: [{ strategyClassId: 'stock', percent: 100 }],
    })
    expect(r.source).toBe('auto')
    expect(r.mixOrigin).toBe('preset')
    expect(r.entries).toEqual([{ strategyClassId: 'bond-mid', percent: 100 }])
  })

  it('表里没有的代码 → 名称关键词', () => {
    const r = resolveItemMapping({
      item: usFund('Some Total Bond Market ETF', 'ZZBOND'),
      category: stockCat,
      strategy: aw,
    })
    expect(r.mixOrigin).toBe('name')
    expect(r.entries).toEqual([{ strategyClassId: 'bond-mid', percent: 100 }])
  })

  it('GLD（黄金 ETF）→ 黄金桶', () => {
    const r = resolveItemMapping({
      item: usFund('SPDR Gold Shares', 'GLD'),
      category: stockCat,
      strategy: aw,
    })
    expect(r.entries).toEqual([{ strategyClassId: 'gold', percent: 100 }])
  })

  it('QQQ 命中内置预设 → 股票', () => {
    const r = resolveItemMapping({ item: usFund('Invesco QQQ Trust', 'QQQ'), category: stockCat, strategy: aw })
    expect(r.entries).toEqual([{ strategyClassId: 'stock', percent: 100 }])
    expect(r.mixOrigin).toBe('preset')
  })

  it('预设与名称都认不出 → 退回形态（个股仍是股票）', () => {
    const r = resolveItemMapping({ item: usFund('Invesco ZZZ Trust', 'ZZZZ'), category: stockCat, strategy: aw })
    expect(r.entries).toEqual([{ strategyClassId: 'stock', percent: 100 }])
    expect(r.mixOrigin).toBe('shape')
  })

  it('手动设置永远优先于名称识别', () => {
    const r = resolveItemMapping({
      item: usFund('Vanguard Total Bond Market ETF', 'BND'),
      category: stockCat,
      strategy: aw,
      itemMapping: { 'us:BND': { entries: [{ strategyClassId: 'stock', percent: 100 }] } },
    })
    expect(r.source).toBe('manual-item')
    expect(r.entries).toEqual([{ strategyClassId: 'stock', percent: 100 }])
  })
})
