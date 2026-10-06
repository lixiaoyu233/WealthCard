import { describe, expect, it } from 'vitest'
import type { StrategyClass } from '../types/strategy'
import { BUILTIN_STRATEGIES } from './strategies'
import {
  ZERO_MIX,
  mixFromAllocation,
  inferBondTerm,
  mixFromName,
  mixToEntries,
  normalizeMix,
  parsePct,
  resolveSemantic,
  semanticOfClass,
  unclassifiedRatio,
} from './assetMix'

const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!
const pm = BUILTIN_STRATEGIES.find((s) => s.id === 'permanent')!
const c64 = BUILTIN_STRATEGIES.find((s) => s.id === 'classic-60-40')!

const entriesOf = (mix: Partial<typeof ZERO_MIX>, strategy = aw, bondTerm?: 'long' | 'mid') =>
  Object.fromEntries(
    mixToEntries({ ...ZERO_MIX, ...mix }, strategy, { bondTerm }).map((e) => [e.strategyClassId, e.percent]),
  )

describe('normalizeMix：必须归一化（杠杆债基的占净比会超过 100%）', () => {
  it('股+债 111.58% → 缩放到 1', () => {
    const mix = normalizeMix({ equity: 19.04, bond: 92.5 })
    expect(mix.equity + mix.bond).toBeCloseTo(1, 6)
    expect(mix.bond).toBeCloseTo(92.5 / 111.54, 4)
  })
  it('债 118.93% 单独一项 → 100% 债券', () => {
    expect(normalizeMix({ bond: 118.93 }).bond).toBe(1)
  })
  it('负数与脏值截成 0；全空返回零向量', () => {
    expect(normalizeMix({ equity: -5, bond: 10 }).bond).toBe(1)
    expect(normalizeMix({})).toEqual(ZERO_MIX)
    expect(normalizeMix(null)).toEqual(ZERO_MIX)
  })
})

describe('parsePct：接口里的 -- 表示没有数据', () => {
  it('正常值 / 百分比号', () => {
    expect(parsePct('95.92')).toBe(95.92)
    expect(parsePct('12%')).toBe(12)
  })
  it('-- / 空 / null → undefined', () => {
    expect(parsePct('--')).toBeUndefined()
    expect(parsePct('-')).toBeUndefined()
    expect(parsePct('')).toBeUndefined()
    expect(parsePct(undefined)).toBeUndefined()
  })
})

describe('mixFromAllocation：东财资产配置 → 资产占比', () => {
  it('沪深300ETF：股 95.92 / 现金 4.05 / 其他 0.03', () => {
    const mix = mixFromAllocation({ GP: '95.92', HB: '4.05', QT: '0.03' }, { ftype: '指数型-股票' })!
    expect(mix.equity).toBeCloseTo(0.9592, 4)
    expect(mix.money).toBeCloseTo(0.0405, 4)
    expect(mix.other).toBeCloseTo(0.0003, 4)
  })

  it('货币基金：接口把同业存单算成「债 50.68%」，必须按类型直接算 100% 现金', () => {
    const mix = mixFromAllocation(
      { ZQ: '50.68', HB: '26.86', QT: '22.46' },
      { ftype: '货币型-普通货币', name: '华宝添益' },
    )!
    expect(mix.money).toBe(1)
    expect(mix.bond).toBe(0)
  })

  it('黄金 ETF：资产几乎全在「其他」里 → 靠类型+名称判成黄金', () => {
    const mix = mixFromAllocation({ HB: '0.39', QT: '99.61' }, { ftype: '指数型-其他', name: '黄金ETF华安' })!
    expect(mix.gold).toBe(1)
    expect(mix.other).toBe(0)
  })

  it('二级债基：股 19.04 / 债 92.5 归一化后仍以债为主', () => {
    const mix = mixFromAllocation({ GP: '19.04', ZQ: '92.5' }, { ftype: '债券型-混合二级' })!
    expect(mix.bond).toBeGreaterThan(0.8)
    expect(mix.equity).toBeGreaterThan(0.1)
  })

  it('全都没有数据 → undefined（让上层标注「未识别」）', () => {
    expect(mixFromAllocation({ GP: '--', ZQ: '--', HB: '--', QT: '--' })).toBeUndefined()
    expect(mixFromAllocation(undefined)).toBeUndefined()
  })
})

describe('mixFromName：拉不到接口数据时的兜底（界面标为「名称推测」）', () => {
  it('识别债券 / 黄金 / 货币 / 股票', () => {
    expect(mixFromName('易方达纯债债券A')!.bond).toBe(1)
    expect(mixFromName('黄金ETF华安')!.gold).toBe(1)
    expect(mixFromName('华宝添益')!.money).toBe(1)
    expect(mixFromName('招商中证白酒指数A')!.equity).toBe(1)
    expect(mixFromName('豆粕ETF')!.commodity).toBe(1)
  })

  it('混合型给一个折中拆分（比整笔算股票接近事实）', () => {
    const mix = mixFromName('易方达蓝筹精选混合')!
    expect(mix.equity).toBeCloseTo(0.6, 6)
    expect(mix.bond).toBeCloseTo(0.4, 6)
  })

  it('认不出名字就返回 undefined —— 美股/港股「默认算股票」由形态兜底负责', () => {
    expect(mixFromName('SPY', 'us')).toBeUndefined()
    expect(mixFromName('Invesco QQQ Trust', 'us')).toBeUndefined()
  })

  it('认不出来的名字 → undefined', () => {
    expect(mixFromName('某某理财产品')).toBeUndefined()
    expect(mixFromName(undefined)).toBeUndefined()
  })
})

describe('semanticOfClass：策略类别的语义', () => {
  it('显式字段优先', () => {
    expect(semanticOfClass({ id: 'bond-long', name: '国债', target: 25, color: '', semantic: 'bond' })).toBe('bond')
  })
  it('按 id 推断', () => {
    expect(semanticOfClass({ id: 'bond-mid', name: '任意名', target: 1, color: '' })).toBe('bond-mid')
  })
  it('按名称兜底', () => {
    expect(semanticOfClass({ id: 'x1', name: '长期国债', target: 1, color: '' })).toBe('bond-long')
    expect(semanticOfClass({ id: 'x2', name: '现金管理', target: 1, color: '' })).toBe('cash')
    expect(semanticOfClass({ id: 'x3', name: '黄金', target: 1, color: '' })).toBe('gold')
  })
})

describe('resolveSemantic：策略里没有这个桶时的兜底', () => {
  const has = (strategy: typeof aw) => (s: string) => strategy.classes.some((c) => semanticOfClass(c) === s)
  it('60/40：黄金与现金都并入债券', () => {
    expect(resolveSemantic('gold', c64, has(c64))).toBe('bond')
    expect(resolveSemantic('cash', c64, has(c64))).toBe('bond')
    expect(resolveSemantic('commodity', c64, has(c64))).toBe('bond')
  })
  it('永久组合：没有大宗商品桶 → 并进黄金', () => {
    expect(resolveSemantic('commodity', pm, has(pm))).toBe('gold')
  })
  it('全天候：没有通用「债券」桶 → 默认中期', () => {
    expect(resolveSemantic('bond', aw, has(aw))).toBe('bond-mid')
  })
  it('策略里真的没有对应语义 → undefined（未归类）', () => {
    expect(resolveSemantic('other', c64, has(c64))).toBeUndefined()
  })
})

describe('mixToEntries：资产占比 → 策略桶（对照表）', () => {
  it('全天候：股票 96% + 现金 4%', () => {
    expect(entriesOf({ equity: 0.96, money: 0.04 })).toEqual({ stock: 96, cash: 4 })
  })

  it('全天候：债券按期限分档（不选默认中期）', () => {
    expect(entriesOf({ bond: 1 })).toEqual({ 'bond-mid': 100 })
    expect(entriesOf({ bond: 1 }, aw, 'long')).toEqual({ 'bond-long': 100 })
    expect(entriesOf({ bond: 1 }, aw, 'mid')).toEqual({ 'bond-mid': 100 })
  })

  it('全天候：黄金与大宗商品各有各的桶', () => {
    expect(entriesOf({ gold: 0.5, commodity: 0.5 })).toEqual({ gold: 50, commodity: 50 })
  })

  it('永久组合：长期/中期国债都并进「国债」桶', () => {
    expect(entriesOf({ bond: 1 }, pm)).toEqual({ 'bond-long': 100 })
    expect(entriesOf({ bond: 1 }, pm, 'long')).toEqual({ 'bond-long': 100 })
  })

  it('经典 60/40：黄金与现金并入债券，其余按股票', () => {
    expect(entriesOf({ equity: 0.5, gold: 0.25, money: 0.25 }, c64)).toEqual({ stock: 50, bond: 50 })
  })

  it('落不进任何桶的部分不静默合并（60/40 没有「其他」）', () => {
    expect(entriesOf({ other: 1 }, c64)).toEqual({})
    expect(unclassifiedRatio({ ...ZERO_MIX, equity: 0.5, other: 0.5 }, c64)).toBeCloseTo(0.5, 6)
  })
})

describe('策略类别的语义完整性', () => {
  it('三个内置策略的每个类别都能推断出语义', () => {
    for (const strategy of BUILTIN_STRATEGIES) {
      for (const cls of strategy.classes as StrategyClass[]) {
        expect(semanticOfClass(cls), `${strategy.id} / ${cls.name}`).toBeDefined()
      }
    }
  })
})


describe('美股/港股 ETF：靠英文名兜底（拿不到资产配置数据）', () => {
  it('债券类 ETF 不再被一律当成股票', () => {
    expect(mixFromName('Vanguard Total Bond Market ETF', 'us')!.bond).toBe(1)
    expect(mixFromName('iShares Core U.S. Aggregate Bond ETF', 'us')!.bond).toBe(1)
    expect(mixFromName('iShares 20+ Year Treasury Bond ETF', 'us')!.bond).toBe(1)
    expect(mixFromName('SPDR Bloomberg 1-3 Month T-Bill ETF', 'us')!.money).toBe(1)
  })

  it('黄金 / 商品 / REITs', () => {
    expect(mixFromName('SPDR Gold Shares', 'us')!.gold).toBe(1)
    expect(mixFromName('United States Oil Fund', 'us')!.commodity).toBe(1)
    expect(mixFromName('Vanguard Real Estate ETF', 'us')!.other).toBe(1)
  })

  it('股票类 ETF 仍然算股票（QQQ 这种认不出的由形态兜底成股票）', () => {
    expect(mixFromName('SPDR S&P 500 ETF Trust', 'us')!.equity).toBe(1)
    expect(mixFromName('Schwab US Dividend Equity ETF', 'us')!.equity).toBe(1)
  })

  it('英文名也能判久期：20+ 年国债 → 长期，1-3 年 → 中期', () => {
    expect(inferBondTerm('iShares 20+ Year Treasury Bond ETF')).toBe('long')
    expect(inferBondTerm('iShares Short-Term Treasury Bond ETF')).toBe('mid')
    expect(inferBondTerm('Vanguard Total Bond Market ETF')).toBeUndefined()
  })
})
