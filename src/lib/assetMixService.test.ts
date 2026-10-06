// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  ASSET_MIX_CACHE_KEY,
  MIX_TTL_MS,
  allocationUrl,
  basicInfoUrl,
  buildMixEntry,
  canFetchMix,
  fetchAssetMix,
  loadMixCache,
  mixFresh,
  mixKey,
  normalizeMixCache,
  parseAllocationPayload,
  parseBasicInformation,
  saveMixCache,
} from './assetMixService'

const skipApi = process.env.ACW_SKIP_API === '1'

/** 真实响应片段（2026-10 实测） */
const BASIC_510300 = {
  Datas: {
    FCODE: '510300',
    SHORTNAME: '沪深300ETF华泰柏瑞',
    FTYPE: '指数型-股票',
    DWJZ: '4.4312',
  },
}
const ALLOC_510300 = {
  Datas: [{ FSRQ: '2026-06-30', GP: '95.92', ZQ: '--', HB: '4.05', JZC: '948.7218', QT: '0.03' }],
}
const ALLOC_MONEY = { Datas: [{ FSRQ: '2026-06-30', GP: '--', ZQ: '50.68', HB: '26.86', QT: '22.46' }] }
const ALLOC_GOLD = { Datas: [{ FSRQ: '2026-06-30', GP: '--', ZQ: '--', HB: '0.39', QT: '99.61' }] }

describe('接口地址与可拉取范围', () => {
  it('地址带上基金代码', () => {
    expect(allocationUrl('510300')).toContain('Funceholder'.replace('Funceholder', 'FundMNAssetAllocationNew'))
    expect(allocationUrl('510300')).toContain('FCODE=510300')
    expect(basicInfoUrl('161725')).toContain('FundMNBasicInformation')
    expect(basicInfoUrl('161725')).toContain('FCODE=161725')
  })

  it('只有中国上市的 6 位代码才拉（美股/港股交给名称推测或手动）', () => {
    expect(canFetchMix('cn', '161725')).toBe(true)
    expect(canFetchMix('ashare', '510300')).toBe(true)
    expect(canFetchMix(undefined, '161725')).toBe(true)
    expect(canFetchMix('us', 'SPY')).toBe(false)
    expect(canFetchMix('hk', '00700')).toBe(false)
    expect(canFetchMix('cn', '12345')).toBe(false)
  })

  it('缓存 key 用「市场:代码」', () => {
    expect(mixKey('ashare', '510300')).toBe('ashare:510300')
    expect(mixKey(undefined, '161725')).toBe('cn:161725')
    expect(mixKey('us', 'spy')).toBe('us:SPY')
  })
})

describe('解析接口响应', () => {
  it('基本信息：全称 + 基金类型', () => {
    expect(parseBasicInformation(BASIC_510300)).toEqual({ name: '沪深300ETF华泰柏瑞', ftype: '指数型-股票' })
    expect(parseBasicInformation({ Datas: null })).toBeUndefined()
    expect(parseBasicInformation(null)).toBeUndefined()
  })

  it('资产配置：取最新一期', () => {
    expect(parseAllocationPayload(ALLOC_510300)).toEqual({
      FSRQ: '2026-06-30',
      GP: '95.92',
      ZQ: '--',
      HB: '4.05',
      QT: '0.03',
    })
    expect(parseAllocationPayload({ Datas: [] })).toBeUndefined()
    expect(parseAllocationPayload({})).toBeUndefined()
  })
})

describe('buildMixEntry：合成缓存记录（含两条实测特例）', () => {
  it('沪深300ETF → 股票约 96% / 现金 4%', () => {
    const entry = buildMixEntry(parseBasicInformation(BASIC_510300), parseAllocationPayload(ALLOC_510300), 1000)!
    expect(entry.mix.equity).toBeCloseTo(0.9592, 3)
    expect(entry.mix.money).toBeCloseTo(0.0405, 3)
    expect(entry.reportDate).toBe('2026-06-30')
    expect(entry.ftype).toBe('指数型-股票')
    expect(entry.name).toBe('沪深300ETF华泰柏瑞')
    expect(entry.fetchedAt).toBe(1000)
  })

  it('货币基金：接口把同业存单写成「债 50.68%」，按类型直接算 100% 现金', () => {
    const entry = buildMixEntry({ name: '华宝添益', ftype: '货币型-普通货币' }, parseAllocationPayload(ALLOC_MONEY), 1)!
    expect(entry.mix.money).toBe(1)
  })

  it('黄金 ETF：资产几乎全在「其他」→ 靠类型+名称判成黄金', () => {
    const entry = buildMixEntry({ name: '黄金ETF华安', ftype: '指数型-其他' }, parseAllocationPayload(ALLOC_GOLD), 1)!
    expect(entry.mix.gold).toBe(1)
  })

  it('没有占比数据 → undefined（上层标注未识别）', () => {
    expect(buildMixEntry(undefined, undefined, 1)).toBeUndefined()
    expect(buildMixEntry(undefined, { GP: '--', ZQ: '--', HB: '--', QT: '--' }, 1)).toBeUndefined()
  })
})

describe('缓存', () => {
  it('规范化：脏数据丢弃，合法记录归一化', () => {
    const cache = normalizeMixCache({
      'ashare:510300': { mix: { equity: 95.92, money: 4.05 }, reportDate: '2026-06-30', fetchedAt: 100 },
      bad: null,
      zero: { mix: { equity: 0 }, fetchedAt: 1 },
    })
    expect(Object.keys(cache)).toEqual(['ashare:510300'])
    expect(cache['ashare:510300'].mix.equity).toBeCloseTo(0.9595, 3)
    expect(normalizeMixCache(null)).toEqual({})
  })

  it('读写 localStorage 往返', () => {
    localStorage.clear()
    expect(loadMixCache()).toEqual({})
    const cache = { 'cn:161725': { mix: { equity: 1, bond: 0, money: 0, gold: 0, commodity: 0, other: 0 }, fetchedAt: 5 } }
    expect(saveMixCache(cache)).toBeNull()
    expect(localStorage.getItem(ASSET_MIX_CACHE_KEY)).toContain('cn:161725')
    expect(loadMixCache()['cn:161725'].mix.equity).toBe(1)
  })

  it('TTL：7 天内算新鲜，过期仍可用但要标记', () => {
    const now = 10 * MIX_TTL_MS
    expect(mixFresh({ mix: { equity: 1, bond: 0, money: 0, gold: 0, commodity: 0, other: 0 }, fetchedAt: now - 1000 }, now)).toBe(true)
    expect(mixFresh({ mix: { equity: 1, bond: 0, money: 0, gold: 0, commodity: 0, other: 0 }, fetchedAt: now - MIX_TTL_MS - 1 }, now)).toBe(false)
    expect(mixFresh(undefined, now)).toBe(false)
  })
})

describe.skipIf(skipApi)('真实接口：资产占比', () => {
  it('510300 能拉到股票占比 > 90%，且带报告期', async () => {
    const entry = await fetchAssetMix('510300')
    expect(entry).toBeDefined()
    expect(entry!.mix.equity).toBeGreaterThan(0.9)
    expect(entry!.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    console.log(`[穿透] 510300 ${entry!.name} 股=${(entry!.mix.equity * 100).toFixed(2)}% 报告期=${entry!.reportDate}`)
  }, 25_000)

  it('国债 ETF 511010 以债券为主', async () => {
    const entry = await fetchAssetMix('511010')
    expect(entry!.mix.bond).toBeGreaterThan(0.9)
  }, 25_000)

  it('美股上市 ETF（SPY）拿不到数据 → undefined', async () => {
    expect(await fetchAssetMix('SPY')).toBeUndefined()
  }, 25_000)
})
