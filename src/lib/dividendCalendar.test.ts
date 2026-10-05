import { describe, expect, it } from 'vitest'
import type { DividendRecord } from './dividends'
import {
  addMonths,
  buildMonthGrid,
  buildMonthView,
  buildPeriodSummary,
  classifyMonthDates,
  estimateUpcoming,
  median,
  periodRange,
} from './dividendCalendar'

const rec = (over: Partial<DividendRecord>): DividendRecord => ({
  id: over.id ?? 'r_' + String(over.exDate),
  code: over.code ?? '600519',
  market: over.market ?? 'ashare',
  exDate: over.exDate ?? '2026-01-01',
  cashPerUnit: over.cashPerUnit ?? 1,
  currency: over.currency ?? 'CNY',
  frequency: over.frequency ?? 'irregular',
  source: over.source ?? 'auto',
  ...over,
})

describe('addMonths', () => {
  it('月末自动夹到当月最后一天', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30')
  })
  it('跨年', () => {
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
  })
})

describe('median', () => {
  it('奇偶都正确', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('estimateUpcoming：按周期推算', () => {
  it('每季：上一次 09-15 → 下一次 12-15', () => {
    const records = [
      rec({ exDate: '2026-03-15', frequency: 'quarterly' }),
      rec({ exDate: '2026-06-15', frequency: 'quarterly' }),
      rec({ exDate: '2026-09-15', frequency: 'quarterly', cashPerUnit: 1.2 }),
    ]
    const [e] = estimateUpcoming(records, '2026-10-05')
    expect(e.nextDate).toBe('2026-12-15')
    // 金额取最近几次的中位数（防单次异常），[1, 1, 1.2] 的中位数是 1
    expect(e.cashPerUnit).toBeCloseTo(1, 6)
    expect(e.basis).toContain('每 3 个月')
  })

  it('每年：今年那次已过就推到明年', () => {
    const records = [rec({ exDate: '2025-06-20', frequency: 'annual' })]
    const [e] = estimateUpcoming(records, '2026-10-05')
    expect(e.nextDate).toBe('2027-06-20')
  })

  it('已有未来记录（已确认）时不推算，避免重复', () => {
    const records = [
      rec({ exDate: '2026-06-15', frequency: 'quarterly' }),
      rec({ exDate: '2026-12-15', frequency: 'quarterly' }),
    ]
    expect(estimateUpcoming(records, '2026-10-05')).toEqual([])
  })

  it('不定期：按历史同月（需 ≥2 个年份）', () => {
    const records = [
      rec({ exDate: '2024-06-10', frequency: 'irregular' }),
      rec({ exDate: '2025-06-20', frequency: 'irregular' }),
      rec({ exDate: '2026-06-15', frequency: 'irregular' }),
    ]
    const [e] = estimateUpcoming(records, '2026-10-05')
    expect(e.nextDate).toBe('2027-06-15')
    expect(e.basis).toContain('历史同月')
  })

  it('不定期但只有一年记录：不推算', () => {
    expect(estimateUpcoming([rec({ exDate: '2026-06-15', frequency: 'irregular' })], '2026-10-05')).toEqual([])
  })

  it('很久没分红也只推算「下一次」，不会吐出过期日期', () => {
    const records = [rec({ exDate: '2020-01-10', frequency: 'monthly' })]
    const [e] = estimateUpcoming(records, '2026-10-05')
    // 每月 10 号派息：今天 10-05，下一次就是 10-10
    expect(e.nextDate).toBe('2026-10-10')
  })
})

describe('buildMonthView', () => {
  it('确认段放未来已公告；预计段放推算结果', () => {
    const records = [
      rec({ code: '600519', exDate: '2026-10-20', cashPerUnit: 15 }),
      rec({ code: '000001', exDate: '2026-06-15', frequency: 'quarterly', cashPerUnit: 0.5 }),
    ]
    const view = buildMonthView(records, '2026-10', '2026-10-05')
    expect(view.confirmed.map((e) => e.record.code)).toEqual(['600519'])
    // 000001 每季：09-15 已过 → 推 12-15，不在 10 月
    expect(view.estimated).toEqual([])
  })

  it('推算落在本月时进预计段', () => {
    const records = [
      rec({ code: '000001', exDate: '2026-06-15', frequency: 'quarterly', cashPerUnit: 0.5 }),
      rec({ code: '000002', exDate: '2026-07-20', frequency: 'quarterly', cashPerUnit: 0.3 }),
    ]
    const view = buildMonthView(records, '2026-10', '2026-10-05')
    expect(view.estimated.map((e) => e.record.exDate)).toEqual(['2026-10-20'])
  })

  it('过去的记录不算「本月已确认」', () => {
    const records = [rec({ exDate: '2026-10-01' })]
    expect(buildMonthView(records, '2026-10', '2026-10-05').confirmed).toEqual([])
  })
})

describe('buildMonthGrid：月历网格（周一开头）', () => {
  it('2026-10：1 号是周四 → 前面空 3 格，总共 5 行', () => {
    const weeks = buildMonthGrid('2026-10')
    expect(weeks[0].slice(0, 4).map((c) => c?.day ?? null)).toEqual([null, null, null, 1])
    expect(weeks.length).toBe(5)
    expect(weeks.flat().filter(Boolean)).toHaveLength(31)
    expect(weeks[4].map((c) => c?.day ?? null)).toEqual([26, 27, 28, 29, 30, 31, null])
  })

  it('2026-02（平年）：28 天', () => {
    const cells = buildMonthGrid('2026-02').flat().filter(Boolean)
    expect(cells).toHaveLength(28)
    expect(cells[27]?.date).toBe('2026-02-28')
  })
})

describe('classifyMonthDates：日历上的三类标记', () => {
  it('未来=已确认，过去=已产生，推算出=预计', () => {
    const records = [
      rec({ id: 'a', exDate: '2026-10-20' }), // 未来
      rec({ id: 'b', exDate: '2026-10-02' }), // 已过去
      rec({ id: 'c', code: '000002', exDate: '2026-07-15', frequency: 'quarterly' }), // 每季 → 10-15 预计
    ]
    const marks = classifyMonthDates(records, '2026-10', '2026-10-05')
    expect(marks.confirmed).toEqual(['2026-10-20'])
    expect(marks.produced).toEqual(['2026-10-02'])
    expect(marks.estimated).toEqual(['2026-10-15'])
  })

  it('同一天多笔只留一个日期；其他月份不混进来', () => {
    const records = [
      rec({ id: 'a', exDate: '2026-10-20' }),
      rec({ id: 'b', exDate: '2026-10-20' }),
      rec({ id: 'c', exDate: '2026-11-01' }),
    ]
    const marks = classifyMonthDates(records, '2026-10', '2026-10-05')
    expect(marks.confirmed).toEqual(['2026-10-20'])
    expect(marks.produced).toEqual([])
  })
})

describe('buildPeriodSummary / periodRange', () => {
  it('本月 / 本季 / 今年 的区间', () => {
    expect(periodRange('month', '2026-10-05')).toEqual({ start: '2026-10-01', end: '2026-10-05' })
    expect(periodRange('quarter', '2026-10-05')).toEqual({ start: '2026-10-01', end: '2026-10-05' })
    expect(periodRange('quarter', '2026-05-05')).toEqual({ start: '2026-04-01', end: '2026-05-05' })
    expect(periodRange('year', '2026-10-05')).toEqual({ start: '2026-01-01', end: '2026-10-05' })
  })

  it('只取已产生（≤今天）且落在区间内的，倒序', () => {
    const records = [
      rec({ exDate: '2026-10-01' }),
      rec({ exDate: '2026-03-10' }),
      rec({ exDate: '2026-11-01' }),
      rec({ exDate: '2025-12-31' }),
    ]
    expect(buildPeriodSummary(records, 'year', '2026-10-05').map((r) => r.exDate)).toEqual(['2026-10-01', '2026-03-10'])
    expect(buildPeriodSummary(records, 'month', '2026-10-05').map((r) => r.exDate)).toEqual(['2026-10-01'])
  })
})
