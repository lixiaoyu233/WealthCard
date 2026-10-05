import { useMemo, useState } from 'react'
import { ChevronRight, HandCoins } from 'lucide-react'
import type { Portfolio } from '../types/asset'
import type { FxRates } from '../lib/currency'
import { estimateAmountCny, type DividendRecord } from '../lib/dividends'
import {
  buildMonthView,
  buildPeriodSummary,
  classifyMonthDates,
  type DividendPeriod,
} from '../lib/dividendCalendar'
import type { DividendSettings } from '../lib/settings'
import type { UseDividends } from '../hooks/useDividends'
import { formatCNY, todayKey } from '../lib/format'
import DividendMonthCalendar from './DividendMonthCalendar'
import DividendEventRow, { type DividendRowContext } from './DividendEventRow'

interface DividendHomeCardProps {
  portfolio: Portfolio
  dividends: UseDividends
  rates?: FxRates | null
  dividendSettings: DividendSettings
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
  onOpenAll: () => void
  onNeedCashAccount: () => void
}

const PERIOD_LABEL: Record<DividendPeriod, string> = { month: '本月', quarter: '本季', year: '本年' }

/**
 * 首页「分红日历」区块：
 * - 真实月历（可翻月），有分红的日子画标记（红圈=已确认 / 虚圈=预计 / 实点=已产生）
 * - 点某天 → 下面列出当天明细
 * - 不选日期时 → 列出「已产生」的分红，可按 本月 / 本季 / 本年 切换，并可直接入账
 */
export default function DividendHomeCard({
  portfolio,
  dividends,
  rates,
  dividendSettings,
  notify,
  onOpenAll,
  onNeedCashAccount,
}: DividendHomeCardProps) {
  const today = todayKey()
  const [month, setMonth] = useState(today.slice(0, 7))
  const [selectedDate, setSelectedDate] = useState<string | undefined>(undefined)
  const [period, setPeriod] = useState<DividendPeriod>('month')

  const tax = { us: dividendSettings.usTaxRate, hk: dividendSettings.hkTaxRate }
  const records = dividends.records

  const marks = useMemo(() => classifyMonthDates(records, month, today), [records, month, today])
  const view = useMemo(() => buildMonthView(records, month, today), [records, month, today])
  const produced = useMemo(() => buildPeriodSummary(records, period, today), [records, period, today])

  const monthEvents = useMemo(
    () => [
      ...view.confirmed.map((e) => ({ record: e.record, kind: 'confirmed' as const, basis: e.basis })),
      ...view.estimated.map((e) => ({ record: e.record, kind: 'estimated' as const, basis: e.basis })),
    ],
    [view],
  )
  const monthTotal = monthEvents.reduce((sum, e) => sum + estimateAmountCny(portfolio, e.record, tax, rates), 0)

  /** 点选某天：当天全部记录（未来=已确认，过去=已产生，推算=预计） */
  const dayEvents = useMemo(() => {
    if (!selectedDate) return []
    const out: Array<{ record: DividendRecord; kind: 'confirmed' | 'estimated'; basis?: string }> = []
    for (const e of monthEvents) {
      if (e.record.exDate === selectedDate) out.push(e)
    }
    for (const r of records) {
      if (r.exDate === selectedDate && r.exDate <= today) out.push({ record: r, kind: 'confirmed' })
    }
    return out
  }, [selectedDate, monthEvents, records, today])

  const rowCtx: DividendRowContext = {
    portfolio,
    dividends,
    rates,
    tax,
    defaultMode: dividendSettings.defaultMode,
    defaultCashTarget: dividendSettings.defaultCashTarget,
    notify,
    onNeedCashAccount,
    hideDelete: true,
  }

  return (
    <div className="rounded-card border border-line bg-s2 px-4 py-3.5" data-testid="dividend-home-card">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink4">
          <HandCoins size={13} /> 分红日历
        </span>
        <button
          type="button"
          data-testid="dividend-home-open"
          onClick={onOpenAll}
          className="inline-flex items-center gap-0.5 text-[11.5px] text-ink3 underline-offset-2 hover:underline"
        >
          查看全部 <ChevronRight size={12} />
        </button>
      </div>

      <div className="mt-2">
        <DividendMonthCalendar
          month={month}
          today={today}
          marks={marks}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          onMonthChange={(next) => {
            setMonth(next)
            setSelectedDate(undefined)
          }}
        />
      </div>

      <p className="mt-2 text-[12px] text-ink4">
        <span className="text-[15px] font-semibold tabular-nums text-ink1">≈ {formatCNY(monthTotal, 2)}</span>
        <span className="ml-2">
          {month} · 已确认 {view.confirmed.length} 笔 · 预计 {view.estimated.length} 笔
        </span>
      </p>

      {records.length === 0 ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink4" data-testid="dividend-home-empty">
          未录入分红信息。
        </p>
      ) : selectedDate ? (
        <div className="mt-2 border-t border-line pt-2">
          <p className="mb-1.5 text-[11.5px] text-ink4">
            {selectedDate} 的分红（{dayEvents.length} 笔）
            <button
              type="button"
              data-testid="dividend-home-clearday"
              onClick={() => setSelectedDate(undefined)}
              className="ml-2 text-ink3 underline-offset-2 hover:underline"
            >
              看全部
            </button>
          </p>
          {dayEvents.length === 0 ? (
            <p className="text-[11.5px] text-ink4">这天没有分红记录。</p>
          ) : (
            <ul className="space-y-2">
              {dayEvents.map((e) => (
                <DividendEventRow key={e.record.id} record={e.record} kind={e.kind} basis={e.basis} ctx={rowCtx} />
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[11.5px] text-ink4">已产生</p>
            <div className="flex gap-1">
              {(['month', 'quarter', 'year'] as DividendPeriod[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`dividend-home-period-${key}`}
                  onClick={() => setPeriod(key)}
                  className={`rounded-lg border px-2 py-0.5 text-[11.5px] transition ${
                    period === key ? 'border-line-strong bg-s3 text-ink1' : 'border-line bg-s2 text-ink4 hover:bg-s3'
                  }`}
                >
                  {PERIOD_LABEL[key]}
                </button>
              ))}
            </div>
          </div>
          {produced.length === 0 ? (
            <p className="text-[11.5px] text-ink4">这个区间还没有已产生的分红。</p>
          ) : (
            <ul className="space-y-2">
              {produced.slice(0, 4).map((r) => (
                <DividendEventRow key={r.id} record={r} kind="confirmed" ctx={rowCtx} />
              ))}
            </ul>
          )}
          {produced.length > 4 ? (
            <p className="mt-1.5 text-[11px] text-ink4">另有 {produced.length - 4} 笔，点「查看全部」看完整列表</p>
          ) : null}
        </div>
      )}
    </div>
  )
}
