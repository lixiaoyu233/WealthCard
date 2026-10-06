import { describe, expect, it } from 'vitest'
import type { AssetItem, Category, Portfolio } from '../types/asset'
import {
  type DividendRecord,
  afterTaxPerUnit,
  applyBonusShares,
  autoRecordId,
  createEmptyDividendFile,
  depositToCashItem,
  findHolding,
  findHoldings,
  isOrphanRecord,
  orphanRecords,
  reinvestSharesAcross,
  modeOf,
  normalizeDividendFile,
  reinvestShares,
  roundMoney,
  setPref,
  upsertRecords,
} from './dividends'

const record = (over: Partial<DividendRecord> = {}): DividendRecord => ({
  id: over.id ?? 'manual_1',
  code: over.code ?? '600519',
  market: over.market ?? 'ashare',
  exDate: over.exDate ?? '2026-06-20',
  cashPerUnit: over.cashPerUnit ?? 1,
  currency: over.currency ?? 'CNY',
  frequency: over.frequency ?? 'annual',
  source: over.source ?? 'manual',
  ...over,
})

const amount = (id: string, v: number, currency?: 'USD'): AssetItem =>
  ({ id, kind: 'amount', name: id, amount: v, currency })
const fund = (id: string, code: string, shares: number, costNav: number, market?: 'ashare' | 'cn'): AssetItem => ({
  id,
  kind: 'fund',
  name: id,
  code,
  shares,
  costNav,
  market,
})
const cat = (id: string, items: AssetItem[]): Category => ({ id, name: id, subtitle: '', icon: 'x', color: 'x', items })
const pf = (categories: Category[]): Portfolio => ({ version: 2, categories, history: [] })

describe('normalizeDividendFile：脏数据兜底', () => {
  it('非对象返回空文件', () => {
    expect(normalizeDividendFile(null)).toEqual(createEmptyDividendFile())
    expect(normalizeDividendFile('x')).toEqual(createEmptyDividendFile())
  })

  it('缺代码/缺除息日的记录被丢弃，其余补默认值', () => {
    const file = normalizeDividendFile({
      records: [{ code: '600519' }, { exDate: '2026-01-01' }, { code: '600519', exDate: '2026-01-01' }],
    })
    expect(file.records).toHaveLength(1)
    expect(file.records[0].market).toBe('cn')
    expect(file.records[0].source).toBe('auto')
  })

  it('同 id 只保留最后一条；prefs/cache 只留合法值', () => {
    const file = normalizeDividendFile({
      records: [
        { id: 'a', code: '600519', exDate: '2026-01-01', cashPerUnit: 1 },
        { id: 'a', code: '600519', exDate: '2026-01-01', cashPerUnit: 2 },
      ],
      prefs: { 'ashare:600519': 'reinvest', bad: 'x' },
      cache: { '600519': 123, bad: 'no' },
    })
    expect(file.records).toHaveLength(1)
    expect(file.records[0].cashPerUnit).toBe(2)
    expect(file.prefs).toEqual({ 'ashare:600519': 'reinvest' })
    expect(file.cache).toEqual({ '600519': 123 })
  })
})

describe('upsertRecords：抓取幂等 + 保留用户状态', () => {
  it('同 id（市场+代码+除息日）重复抓取不会变两条，并保留已入账标记', () => {
    const id = autoRecordId('ashare', '600519', '2026-06-20')
    let file = upsertRecords(createEmptyDividendFile(), [record({ id, cashPerUnit: 1 })])
    file = upsertRecords(file, [record({ id, cashPerUnit: 1 })])
    expect(file.records).toHaveLength(1)

    file = { ...file, records: file.records.map((r) => ({ ...r, applied: true, mode: 'reinvest' as const })) }
    file = upsertRecords(file, [record({ id, cashPerUnit: 1.5 })])
    expect(file.records).toHaveLength(1)
    expect(file.records[0].applied).toBe(true)
    expect(file.records[0].mode).toBe('reinvest')
    expect(file.records[0].cashPerUnit).toBe(1.5)
  })

  it('按除息日排序', () => {
    const file = upsertRecords(createEmptyDividendFile(), [
      record({ id: 'b', exDate: '2026-06-20' }),
      record({ id: 'a', exDate: '2026-03-01' }),
    ])
    expect(file.records.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('afterTaxPerUnit：税后每份金额', () => {
  it('自动源给了就用它（A股公告口径最准）', () => {
    expect(afterTaxPerUnit(record({ cashPerUnit: 1, afterTaxPerUnit: 0.9 }), { us: 0.3, hk: 0.1 })).toBe(0.9)
  })
  it('没给就按市场税率算；A股不额外扣（公告已是税后口径）', () => {
    expect(afterTaxPerUnit(record({ market: 'us', cashPerUnit: 1 }), { us: 0.3, hk: 0.1 })).toBeCloseTo(0.7, 8)
    expect(afterTaxPerUnit(record({ market: 'hk', cashPerUnit: 1 }), { us: 0.3, hk: 0.1 })).toBeCloseTo(0.9, 8)
    expect(afterTaxPerUnit(record({ market: 'ashare', cashPerUnit: 1 }), { us: 0.3, hk: 0.1 })).toBe(1)
  })
})

describe('findHolding：定位持仓', () => {
  const portfolio = pf([cat('cat_stock', [fund('i1', '600519', 100, 1500, 'ashare'), fund('i2', '161725', 1000, 0.5, 'cn')])])
  it('优先按 itemId', () => {
    expect(findHolding(portfolio, { itemId: 'i2', market: 'ashare', code: '600519' })?.id).toBe('i2')
  })
  it('否则按「市场 + 代码」', () => {
    expect(findHolding(portfolio, { market: 'ashare', code: '600519' })?.id).toBe('i1')
    expect(findHolding(portfolio, { market: 'cn', code: '161725' })?.id).toBe('i2')
  })
  it('找不到返回 undefined（市场不匹配也算找不到，避免入错账）', () => {
    expect(findHolding(portfolio, { market: 'us', code: '600519' })).toBeUndefined()
  })
})

describe('depositToCashItem：现金入账', () => {
  const portfolio = pf([cat('cat_cash', [amount('招行活期', 1000)])])
  it('金额加进指定条目，保留两位', () => {
    const res = depositToCashItem(portfolio, { categoryId: 'cat_cash', itemId: '招行活期' }, 123.456)
    expect(res.ok).toBe(true)
    const item = res.portfolio.categories[0].items[0]
    expect(item.kind === 'amount' && item.amount).toBe(1123.46)
  })
  it('账户不存在 / 不是金额类 / 金额非法 → 拒绝并给出原因', () => {
    expect(depositToCashItem(portfolio, { categoryId: 'x', itemId: 'y' }, 10).ok).toBe(false)
    expect(depositToCashItem(portfolio, { categoryId: 'cat_cash', itemId: '招行活期' }, 0).ok).toBe(false)
  })
  it('外币账户拒绝自动入账（避免静默记错数字）', () => {
    const usd = pf([cat('cat_cash', [amount('美元账户', 100, 'USD')])])
    const res = depositToCashItem(usd, { categoryId: 'cat_cash', itemId: '美元账户' }, 100)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('外币账户')
  })
})

describe('reinvestShares：再投资按买入价加权平均成本', () => {
  it('份额增加、成本被买入价摊平', () => {
    const portfolio = pf([cat('cat_fund', [fund('i1', '161725', 1000, 1.0)])])
    const res = reinvestShares(portfolio, 'i1', 100, 2.0)
    expect(res.ok).toBe(true)
    const item = res.portfolio.categories[0].items[0]
    if (item.kind !== 'fund') throw new Error('类型不对')
    expect(item.shares).toBe(1100)
    // (1000×1.0 + 100×2.0) / 1100
    expect(item.costNav).toBeCloseTo(1200 / 1100, 10)
  })
  it('份额或价格非法时拒绝', () => {
    const portfolio = pf([cat('cat_fund', [fund('i1', '161725', 1000, 1)])])
    expect(reinvestShares(portfolio, 'i1', 0, 2).ok).toBe(false)
    expect(reinvestShares(portfolio, 'i1', 10, 0).ok).toBe(false)
    expect(reinvestShares(portfolio, 'nope', 10, 2).ok).toBe(false)
  })
})

describe('applyBonusShares：送转份额与摊薄', () => {
  it('10 转 4：份额 ×1.4，成本 ÷1.4（总市值不变）', () => {
    const portfolio = pf([cat('cat_stock', [fund('i1', '600519', 100, 100, 'ashare')])])
    const res = applyBonusShares(portfolio, 'i1', 4)
    const item = res.portfolio.categories[0].items[0]
    if (item.kind !== 'fund') throw new Error('类型不对')
    expect(item.shares).toBeCloseTo(140, 10)
    expect(item.costNav).toBeCloseTo(100 / 1.4, 10)
    expect(item.shares * item.costNav).toBeCloseTo(100 * 100, 6)
  })
  it('比例非法时拒绝', () => {
    const portfolio = pf([cat('cat_stock', [fund('i1', '600519', 100, 100, 'ashare')])])
    expect(applyBonusShares(portfolio, 'i1', 0).ok).toBe(false)
  })
})

describe('偏好与工具', () => {
  it('标的级分红方式偏好可读写，默认现金', () => {
    const file = setPref(createEmptyDividendFile(), 'ashare', '600519', 'reinvest')
    expect(modeOf(file, 'ashare', '600519')).toBe('reinvest')
    expect(modeOf(file, 'us', 'SPY')).toBe('cash')
  })
  it('roundMoney 保留两位', () => {
    expect(roundMoney(1.005)).toBe(1.01)
    expect(roundMoney(2.344)).toBe(2.34)
  })
})


describe('两个平台买同一只基金：分红要作用到所有条目', () => {
  const twoPlatforms = () =>
    pf([cat('cat_fund', [fund('f1', '016452', 4.39, 2.2778, 'cn'), fund('f2', '016452', 10, 2.1, 'cn')])])
  const rec = record({ itemId: undefined, code: '016452', market: 'cn', cashPerUnit: 0.1, currency: 'CNY' })

  it('findHoldings 返回全部同代码持仓，findHolding 仍返回第一条', () => {
    const p = twoPlatforms()
    expect(findHoldings(p, rec).map((h) => h.id)).toEqual(['f1', 'f2'])
    expect(findHolding(p, rec)?.id).toBe('f1')
  })

  it('再投资按份额比例分摊，总份额不丢', () => {
    const p = twoPlatforms()
    const res = reinvestSharesAcross(p, [{ id: 'f1', shares: 4.39 }, { id: 'f2', shares: 10 }], 3, 2)
    expect(res.ok).toBe(true)
    const items = res.portfolio.categories[0].items as Array<{ id: string; shares: number; costNav: number }>
    const f1 = items.find((i) => i.id === 'f1')!
    const f2 = items.find((i) => i.id === 'f2')!
    // 4.39 : 10 分摊 3 份
    expect(f1.shares + f2.shares).toBeCloseTo(4.39 + 10 + 3, 6)
    expect(f1.shares).toBeCloseTo(4.39 + (3 * 4.39) / 14.39, 4)
    // 每条成本按自己的加权平均更新
    expect(f1.costNav).toBeCloseTo((4.39 * 2.2778 + f1.shares * 0 + (f1.shares - 4.39) * 2) / f1.shares, 4)
    expect(res.perItem).toHaveLength(2)
  })

  it('送转：两条都按同一比例调整（百分比一致）', () => {
    const p = twoPlatforms()
    const r1 = applyBonusShares(p, 'f1', 5)
    const r2 = applyBonusShares(r1.portfolio, 'f2', 5)
    const items = r2.portfolio.categories[0].items as Array<{ id: string; shares: number; costNav: number }>
    expect(items[0].shares).toBeCloseTo(4.39 * 1.5, 6)
    expect(items[1].shares).toBeCloseTo(10 * 1.5, 6)
    expect(items[0].costNav).toBeCloseTo(2.2778 / 1.5, 6)
    expect(items[1].costNav).toBeCloseTo(2.1 / 1.5, 6)
  })

  it('itemId 绑定的记录只作用于那一条', () => {
    const p = twoPlatforms()
    expect(findHoldings(p, record({ itemId: 'f2', code: '016452', market: 'cn' })).map((h) => h.id)).toEqual(['f2'])
  })
})


describe('删除持仓后留下的分红记录（孤儿记录）', () => {
  it('isOrphanRecord：持仓不在了算失效，还在就不算', () => {
    const p = pf([cat('cat_stock', [fund('i1', '600519', 1000, 1, 'ashare')])])
    expect(isOrphanRecord(p, record({ code: '600519', market: 'ashare' }))).toBe(false)
    expect(isOrphanRecord(p, record({ code: '000858', market: 'ashare' }))).toBe(true)
    // 市场对不上也算失效（同代码不同市场是两回事）
    expect(isOrphanRecord(p, record({ code: '600519', market: 'us' }))).toBe(true)
  })

  it('orphanRecords 过滤出失效的那些', () => {
    const p = pf([cat('cat_stock', [fund('i1', '600519', 1000, 1, 'ashare')])])
    const rs = [
      record({ id: 'a', code: '600519', market: 'ashare' }),
      record({ id: 'b', code: '000858', market: 'ashare' }),
    ]
    expect(orphanRecords(p, rs).map((r) => r.id)).toEqual(['b'])
  })
})
