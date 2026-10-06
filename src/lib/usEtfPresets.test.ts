import { describe, expect, it } from 'vitest'
import { ETF_PRESET_COUNT, presetOf } from './usEtfPresets'
import { BUILTIN_STRATEGIES } from './strategies'
import { resolveItemMapping } from './itemMapping'
import type { AssetItem, Category } from '../types/asset'

const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
const stockCat: Category = { id: 'cat_stock', name: '股票', subtitle: '', icon: 'x', color: '#888', items: [] }
const usEtf = (code: string, name = code): AssetItem =>
  ({ id: `u-${code}`, kind: 'fund', name, code, market: 'us', shares: 100, costNav: 1 }) as AssetItem
const hkEtf = (code: string, name = code): AssetItem =>
  ({ id: `h-${code}`, kind: 'fund', name, code, market: 'hk', shares: 100, costNav: 1 }) as AssetItem

describe('内置预设表', () => {
  it('表里有一批常见 ETF（覆盖度够用即可）', () => {
    expect(ETF_PRESET_COUNT).toBeGreaterThan(80)
  })

  it('单一类别：债券 / 黄金 / 现金 / 大宗商品', () => {
    expect(presetOf('BND', 'us')!.mix.bond).toBe(1)
    expect(presetOf('AGG', 'us')!.mix.bond).toBe(1)
    expect(presetOf('GLD', 'us')!.mix.gold).toBe(1)
    expect(presetOf('SGOV', 'us')!.mix.money).toBe(1)
    expect(presetOf('USO', 'us')!.mix.commodity).toBe(1)
    expect(presetOf('VNQ', 'us')!.mix.other).toBe(1)
    expect(presetOf('SPY', 'us')!.mix.equity).toBe(1)
  })

  it('长久期债券带 bondTerm=long（TLT 这类）', () => {
    expect(presetOf('TLT', 'us')).toMatchObject({ bondTerm: 'long' })
    expect(presetOf('EDV', 'us')).toMatchObject({ bondTerm: 'long' })
    expect(presetOf('BND', 'us')!.bondTerm).toBeUndefined()
  })

  it('混合型：AOA 股债 80/20、BAL 60/40', () => {
    expect(presetOf('AOA', 'us')!.mix).toMatchObject({ equity: 0.8, bond: 0.2 })
    expect(presetOf('BAL', 'us')!.mix).toMatchObject({ equity: 0.6, bond: 0.4 })
    expect(presetOf('AOK', 'us')!.mix).toMatchObject({ equity: 0.3, bond: 0.7 })
  })

  it('港股：五位数代码也能命中（02800 盈富基金）', () => {
    expect(presetOf('02800', 'hk')!.mix.equity).toBe(1)
    expect(presetOf('2800', 'hk')!.mix.equity).toBe(1) // 少写前导零也能认（2800 → 02800）
  })

  it('大小写不敏感；表里没有的返回 undefined（交给名称/形态兜底）', () => {
    expect(presetOf('bnd', 'us')!.mix.bond).toBe(1)
    expect(presetOf('FAKECODE', 'us')).toBeUndefined()
    expect(presetOf(undefined, 'us')).toBeUndefined()
  })
})

describe('预设接进映射链', () => {
  it('BND → 债券桶（而不是按形态算股票）', () => {
    const r = resolveItemMapping({ item: usEtf('BND', 'Vanguard Total Bond Market ETF'), category: stockCat, strategy: aw })
    expect(r.entries).toEqual([{ strategyClassId: 'bond-mid', percent: 100 }])
    expect(r.mixOrigin).toBe('preset')
  })

  it('TLT → 长期国债桶（预设自带久期）', () => {
    const r = resolveItemMapping({ item: usEtf('TLT', 'iShares 20+ Year Treasury Bond ETF'), category: stockCat, strategy: aw })
    expect(r.entries).toEqual([{ strategyClassId: 'bond-long', percent: 100 }])
  })

  it('AOA → 拆成股票 80 / 债券 20', () => {
    const r = resolveItemMapping({ item: usEtf('AOA', 'iShares Core Aggressive Allocation ETF'), category: stockCat, strategy: aw })
    expect(Object.fromEntries(r.entries.map((e) => [e.strategyClassId, e.percent]))).toEqual({
      stock: 80,
      'bond-mid': 20,
    })
  })

  it('表里没有的（QQQ 之外的冷门）退回名称/形态', () => {
    const r = resolveItemMapping({ item: usEtf('ZZZZ', 'Some Unknown Growth Fund'), category: stockCat, strategy: aw })
    expect(r.mixOrigin).not.toBe('preset')
    expect(r.entries).toEqual([{ strategyClassId: 'stock', percent: 100 }])
  })

  it('手动设置仍然最高优先级', () => {
    const r = resolveItemMapping({
      item: usEtf('BND'),
      category: stockCat,
      strategy: aw,
      itemMapping: { 'us:BND': { entries: [{ strategyClassId: 'gold', percent: 100 }] } },
    })
    expect(r.source).toBe('manual-item')
    expect(r.entries).toEqual([{ strategyClassId: 'gold', percent: 100 }])
  })

  it('港股预设也生效', () => {
    const r = resolveItemMapping({ item: hkEtf('02800', '盈富基金'), category: stockCat, strategy: aw })
    expect(r.entries).toEqual([{ strategyClassId: 'stock', percent: 100 }])
    expect(r.mixOrigin).toBe('preset')
  })
})
