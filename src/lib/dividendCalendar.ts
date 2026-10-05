/**
 * 分红日历的纯计算：确认 / 预计分类、按周期或历史推算、月度与区间汇总。
 *
 * 只用字符串日期（YYYY-MM-DD），不引入时区 —— 日期口径与数据源保持一致，
 * 避免「美股除息日在半夜显示成前一天」这类问题。
 */
import type { DividendFrequency, DividendRecord } from './dividends'
import { holdingKey } from './dividends'

export const FREQ_STEP_MONTHS: Record<Exclude<DividendFrequency, 'irregular'>, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
}

/** 日期字符串加减月份，自动夹到月末（2026-01-31 + 1 → 2026-02-28） */
export function addMonths(dateKey: string, months: number): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0')
  return base.getUTCFullYear() + '-' + mm + '-' + String(day).padStart(2, '0')
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface Estimate {
  code: string
  market: DividendRecord['market']
  nextDate: string
  cashPerUnit: number
  basis: string
  from: DividendRecord
}

/**
 * 推算下一次分红。
 *
 * 规则：
 * - 该标的已有「未来」记录（自动源拿到的已公告、或手工录入）→ 不推算，避免和确认项重复；
 * - 有明确周期（月/季/半年/年）→ 按周期递推；
 * - 不定期 → 用「历史同月」：同一月份至少在 2 个不同年份出现过，才按该月推算。
 */
export function estimateUpcoming(records: DividendRecord[], today: string, horizonMonths = 12): Estimate[] {
  const byHolding = new Map<string, DividendRecord[]>()
  for (const r of records) {
    const k = holdingKey(r.market, r.code)
    if (!byHolding.has(k)) byHolding.set(k, [])
    byHolding.get(k)!.push(r)
  }
  const horizon = addMonths(today, horizonMonths)
  const out: Estimate[] = []

  for (const list of byHolding.values()) {
    const sorted = [...list].sort((a, b) => a.exDate.localeCompare(b.exDate))
    if (sorted.some((r) => r.exDate > today)) continue
    const last = sorted[sorted.length - 1]
    const amount = median(sorted.slice(-4).map((r) => r.cashPerUnit))

    if (last.frequency !== 'irregular') {
      const step = FREQ_STEP_MONTHS[last.frequency]
      let next = addMonths(last.exDate, step)
      while (next <= today) next = addMonths(next, step)
      if (next <= horizon) {
        out.push({
          code: last.code,
          market: last.market,
          nextDate: next,
          cashPerUnit: amount,
          basis: '按周期推算（上次 ' + last.exDate + '，每 ' + step + ' 个月）',
          from: last,
        })
      }
      continue
    }

    // 不定期：按历史同月
    const byMonth = new Map<number, Array<{ year: number; day: number }>>()
    for (const r of sorted) {
      const month = Number(r.exDate.slice(5, 7))
      if (!byMonth.has(month)) byMonth.set(month, [])
      byMonth.get(month)!.push({ year: Number(r.exDate.slice(0, 4)), day: Number(r.exDate.slice(8, 10)) })
    }
    let best: { month: number; years: number } | null = null
    for (const entry of byMonth.entries()) {
      const month = entry[0]
      const years = new Set(entry[1].map((x) => x.year)).size
      if (years >= 2 && (!best || years > best.years)) best = { month, years }
    }
    if (!best) continue
    const days = byMonth.get(best.month)!.map((x) => x.day)
    const day = Math.min(28, Math.max(1, Math.round(median(days))))
    const mm = String(best.month).padStart(2, '0')
    let next = today.slice(0, 4) + '-' + mm + '-' + String(day).padStart(2, '0')
    while (next <= today) next = String(Number(next.slice(0, 4)) + 1) + '-' + mm + '-' + String(day).padStart(2, '0')
    if (next <= horizon) {
      out.push({
        code: last.code,
        market: last.market,
        nextDate: next,
        cashPerUnit: amount,
        basis: '历史同月推算（过去 ' + best.years + ' 年 ' + best.month + ' 月）',
        from: last,
      })
    }
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate))
}

export interface DividendEvent {
  record: DividendRecord
  kind: 'confirmed' | 'estimated'
  basis?: string
}

export interface MonthView {
  month: string
  confirmed: DividendEvent[]
  estimated: DividendEvent[]
}

/** 某个自然月的分红：已确认（未来日期） + 按历史推算 */
export function buildMonthView(records: DividendRecord[], month: string, today: string): MonthView {
  const confirmed: DividendEvent[] = records
    .filter((r) => r.exDate.startsWith(month) && r.exDate > today)
    .sort((a, b) => a.exDate.localeCompare(b.exDate))
    .map((r) => ({ record: r, kind: 'confirmed' as const }))
  const estimated: DividendEvent[] = estimateUpcoming(records, today)
    .filter((e) => e.nextDate.startsWith(month))
    .map((e) => ({
      record: { ...e.from, id: 'estimate_' + holdingKey(e.market, e.code) + '_' + e.nextDate, exDate: e.nextDate, cashPerUnit: e.cashPerUnit },
      kind: 'estimated' as const,
      basis: e.basis,
    }))
  return { month, confirmed, estimated }
}

export type DividendPeriod = 'month' | 'quarter' | 'year'

export function periodRange(period: DividendPeriod, today: string): { start: string; end: string } {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  if (period === 'month') return { start: today.slice(0, 7) + '-01', end: today }
  if (period === 'quarter') {
    const q = Math.floor((month - 1) / 3) * 3 + 1
    return { start: year + '-' + String(q).padStart(2, '0') + '-01', end: today }
  }
  return { start: year + '-01-01', end: today }
}

/** 已产生的分红（除息日 ≤ 今天），按「年 / 季 / 月」区间取，倒序 */
export function buildPeriodSummary(records: DividendRecord[], period: DividendPeriod, today: string): DividendRecord[] {
  const { start, end } = periodRange(period, today)
  return records
    .filter((r) => r.exDate >= start && r.exDate <= end && r.exDate <= today)
    .sort((a, b) => b.exDate.localeCompare(a.exDate))
}
