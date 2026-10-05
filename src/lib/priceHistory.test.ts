import { describe, expect, it } from 'vitest'
import {
  closeOnOrBefore,
  fetchCloseOnDate,
  fundNavHistoryUrl,
  parseFundNavBars,
  parseTencentDayBars,
  tencentHistoryUrl,
} from './priceHistory'

const skipApi = process.env.ACW_SKIP_API === '1'

describe('腾讯日K解析（不复权 day 字段）', () => {
  const json = {
    code: 0,
    data: {
      sh600519: {
        day: [
          ['2026-06-15', '1292.700', '1271.100', '1292.700', '1270.100', '41586.000'],
          ['2026-06-16', '1270.000', '1260.500', '1275.000', '1258.000', '30000.000'],
        ],
        qt: { sh600519: ['1', '贵州茅台'] },
      },
    },
  }

  it('取第 3 列（收盘价）', () => {
    expect(parseTencentDayBars(json, 'sh600519')).toEqual([
      { date: '2026-06-15', close: 1271.1 },
      { date: '2026-06-16', close: 1260.5 },
    ])
  })

  it('代码不存在或字段缺失时返回空数组，不抛错', () => {
    expect(parseTencentDayBars(json, 'sh999999')).toEqual([])
    expect(parseTencentDayBars(null, 'sh600519')).toEqual([])
  })
})

describe('天天基金历史净值解析', () => {
  it('取 FSRQ + DWJZ', () => {
    expect(
      parseFundNavBars({
        Datas: [
          { FSRQ: '2026-09-30', DWJZ: '0.5314' },
          { FSRQ: '2026-09-29', DWJZ: '0.5169' },
        ],
      }),
    ).toEqual([
      { date: '2026-09-30', close: 0.5314 },
      { date: '2026-09-29', close: 0.5169 },
    ])
  })

  it('脏数据被跳过', () => {
    expect(parseFundNavBars({ Datas: [{ FSRQ: 'x', DWJZ: '1' }, { FSRQ: '2026-01-01', DWJZ: '--' }] })).toEqual([])
  })
})

describe('closeOnOrBefore：非交易日/停牌兜底', () => {
  const bars = [
    { date: '2026-06-12', close: 1300 },
    { date: '2026-06-15', close: 1271.1 },
    { date: '2026-06-16', close: 1260.5 },
  ]
  it('正好当天就用当天', () => {
    expect(closeOnOrBefore(bars, '2026-06-15')).toBe(1271.1)
  })
  it('当天没有数据（周末/停牌）就用之前最近一天', () => {
    expect(closeOnOrBefore(bars, '2026-06-14')).toBe(1300)
  })
  it('全都晚于目标日期时返回 undefined', () => {
    expect(closeOnOrBefore(bars, '2026-06-01')).toBeUndefined()
  })
})

describe('URL 构造', () => {
  it('腾讯日K：复权参数留空（不复权），带日期区间', () => {
    const url = tencentHistoryUrl('sh600519', '2026-05-20', '2026-06-20')
    expect(url).toContain('param=sh600519,day,2026-05-20,2026-06-20,320,')
    expect(url.endsWith(',')).toBe(true) // 末尾没有 qfq
  })
  it('基金历史净值走移动端接口（CORS 开放）', () => {
    expect(fundNavHistoryUrl('161725')).toContain('fundmobapi.eastmoney.com')
    expect(fundNavHistoryUrl('161725')).toContain('FCODE=161725')
  })
})

describe.skipIf(skipApi)('真实接口：除息日不复权价', () => {
  it('A股 600519 能取到指定日期的收盘价（与东财交叉验证：1271.10）', async () => {
    const price = await fetchCloseOnDate('ashare', '600519', '2026-06-15')
    expect(price).toBeCloseTo(1271.1, 2)
  }, 20_000)

  it('港股 00700 能取到', async () => {
    const price = await fetchCloseOnDate('hk', '00700', '2026-06-15')
    expect(price).toBeGreaterThan(0)
  }, 20_000)

  it('场外基金 161725 能取到历史净值', async () => {
    const price = await fetchCloseOnDate('cn', '161725', '2026-09-30')
    expect(price).toBeCloseTo(0.5314, 4)
  }, 20_000)

  it('美股暂不支持：返回 undefined（界面提示手填）', async () => {
    expect(await fetchCloseOnDate('us', 'SPY', '2026-06-15')).toBeUndefined()
  }, 20_000)
})
