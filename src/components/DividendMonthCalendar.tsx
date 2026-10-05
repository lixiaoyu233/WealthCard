import { ChevronLeft, ChevronRight } from 'lucide-react'
import { buildMonthGrid } from '../lib/dividendCalendar'

interface DividendMonthCalendarProps {
  month: string
  today: string
  marks: { confirmed: string[]; estimated: string[]; produced: string[] }
  selectedDate?: string
  onSelectDate: (date: string | undefined) => void
  onMonthChange: (month: string) => void
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

type Mark = 'confirmed' | 'estimated' | 'produced'

/**
 * 标记样式：实心红点=已确认、橙色虚圈=预计、灰色实心点=已产生。
 *
 * ⚠️ 不要写 `bg-ink4/60` 这类「变量色 + 透明度」的类：tailwind.config 里颜色是
 * 普通 `var(--x)` 字符串，Tailwind 不会为它生成带透明度的类名 —— 类名不存在，
 * 圆点就会既没底色也没边框（两种主题下都看不见）。需要半透明请用 index.css 里
 * 手写 color-mix 的 .tone-* / .chip 这类类。
 */
export const MARK_CLASS: Record<Mark, string> = {
  confirmed: 'bg-danger',
  estimated: 'border-2 border-dashed border-warn',
  produced: 'bg-ink3',
}
const MARK_SIZE = 'h-3 w-3'

/** 首页的「真实月历」：可翻月、有分红的日子画标记、点某天看当天明细 */
export default function DividendMonthCalendar({
  month,
  today,
  marks,
  selectedDate,
  onSelectDate,
  onMonthChange,
}: DividendMonthCalendarProps) {
  const weeks = buildMonthGrid(month)
  const confirmed = new Set(marks.confirmed)
  const estimated = new Set(marks.estimated)
  const produced = new Set(marks.produced)
  const [year, monthNum] = month.split('-').map(Number)

  const shift = (delta: number) => {
    const d = new Date(Date.UTC(year, monthNum - 1 + delta, 1))
    onMonthChange(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }

  return (
    <div data-testid="dividend-calendar">
      <div className="flex items-center justify-between">
        <button
          type="button"
          data-testid="dividend-cal-prev"
          aria-label="上个月"
          onClick={() => shift(-1)}
          className="rounded-lg p-1 text-ink4 transition hover:bg-s3 hover:text-ink2"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="text-[12.5px] tabular-nums text-ink1">
          {year} 年 {monthNum} 月
        </span>
        <div className="flex items-center gap-0.5">
          {month !== today.slice(0, 7) ? (
            <button
              type="button"
              data-testid="dividend-cal-today"
              onClick={() => onMonthChange(today.slice(0, 7))}
              className="rounded-lg px-1.5 py-1 text-[11px] text-ink4 transition hover:bg-s3 hover:text-ink2"
            >
              回本月
            </button>
          ) : null}
          <button
            type="button"
            data-testid="dividend-cal-next"
            aria-label="下个月"
            onClick={() => shift(1)}
            className="rounded-lg p-1 text-ink4 transition hover:bg-s3 hover:text-ink2"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-7 gap-y-0.5 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-[10px] text-ink4">
            {w}
          </span>
        ))}
        {weeks.flat().map((cell, i) => {
          if (!cell) return <span key={`empty-${i}`} />
          const mark: Mark | null = confirmed.has(cell.date)
            ? 'confirmed'
            : estimated.has(cell.date)
              ? 'estimated'
              : produced.has(cell.date)
                ? 'produced'
                : null
          const isToday = cell.date === today
          const isSelected = cell.date === selectedDate
          return (
            <button
              key={cell.date}
              type="button"
              data-testid={`dividend-day-${cell.date}`}
              data-mark={mark ?? undefined}
              aria-pressed={isSelected}
              onClick={() => onSelectDate(isSelected ? undefined : cell.date)}
              className={`mx-auto flex w-8 flex-col items-center rounded-lg py-0.5 transition ${
                isSelected ? 'bg-s3' : 'hover:bg-s3'
              }`}
            >
              <span className={`text-[11.5px] tabular-nums ${isToday ? 'font-semibold text-ink1' : 'text-ink3'}`}>
                {cell.day}
              </span>
              <span className="mt-0.5 flex h-2.5 items-center">
                {mark ? <span className={`block rounded-full ${MARK_SIZE} ${MARK_CLASS[mark]}`} /> : null}
              </span>
            </button>
          )
        })}
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-ink4">
        <span className="inline-flex items-center gap-1">
          <span className={`block rounded-full ${MARK_SIZE} ${MARK_CLASS.confirmed}`} /> 已确认
        </span>
        <span className="inline-flex items-center gap-1">
          <span className={`block rounded-full ${MARK_SIZE} ${MARK_CLASS.estimated}`} /> 预计
        </span>
        <span className="inline-flex items-center gap-1">
          <span className={`block rounded-full ${MARK_SIZE} ${MARK_CLASS.produced}`} /> 已产生
        </span>
      </div>
    </div>
  )
}
