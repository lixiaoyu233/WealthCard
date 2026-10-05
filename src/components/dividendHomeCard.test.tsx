// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category, Portfolio } from '../types/asset'
import { createDefaultSettings } from '../lib/settings'
import type { DividendRecord } from '../lib/dividends'
import { makeDividends } from '../test/fixtures'
import DividendHomeCard from './DividendHomeCard'
import { MARK_CLASS } from './DividendMonthCalendar'

const portfolio: Portfolio = {
  version: 2,
  categories: [
    {
      id: 'cat_cash',
      name: '现金与固定资产',
      subtitle: '',
      icon: 'x',
      color: 'x',
      items: [{ id: 'c1', kind: 'amount', name: '招行活期', amount: 10000 }] as AssetItem[],
    } as Category,
    {
      id: 'cat_stock',
      name: '股票',
      subtitle: '',
      icon: 'x',
      color: 'x',
      items: [
        { id: 'i1', kind: 'fund', name: '贵州茅台', code: '600519', market: 'ashare', shares: 100, costNav: 1500 },
      ] as AssetItem[],
    } as Category,
  ],
  history: [],
}

const record = (over: Partial<DividendRecord> = {}): DividendRecord => ({
  id: over.id ?? 'r1',
  code: '600519',
  market: 'ashare',
  name: '贵州茅台',
  exDate: '2026-06-20',
  cashPerUnit: 5,
  afterTaxPerUnit: 5,
  currency: 'CNY',
  frequency: 'annual',
  source: 'auto',
  ...over,
})

const renderCard = (opts: { records?: DividendRecord[]; dividends?: ReturnType<typeof makeDividends> } = {}) => {
  const dividends = opts.dividends ?? makeDividends({ records: opts.records ?? [] })
  const onOpenAll = vi.fn()
  const notify = vi.fn()
  render(
    <DividendHomeCard
      portfolio={portfolio}
      dividends={dividends}
      rates={null}
      dividendSettings={createDefaultSettings().dividends}
      notify={notify}
      onOpenAll={onOpenAll}
      onNeedCashAccount={vi.fn()}
    />,
  )
  return { dividends, onOpenAll, notify }
}

const setToday = () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 5, 10)) // 2026-06-10
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('日历标记的类名（回归守卫）', () => {
  it('不用「变量色 + 透明度」的类：Tailwind 不会为 var(--x) 生成这类类名，圆点会直接消失', () => {
    for (const cls of Object.values(MARK_CLASS)) {
      expect(cls).not.toMatch(/(bg|border|text|ring)-(ink[1-4]|line|line-strong|s[1-4]|app|invert)\/\d+/)
    }
  })

  it('三种标记都用真实存在的类（实心红点 / 橙虚圈 / 灰实心点）', () => {
    expect(MARK_CLASS.confirmed).toContain('bg-danger')
    expect(MARK_CLASS.estimated).toContain('border-dashed')
    expect(MARK_CLASS.estimated).toContain('border-warn')
    expect(MARK_CLASS.produced).toContain('bg-ink3')
  })
})

describe('首页分红日历', () => {
  it('日历按标记区分：未来=已确认、过去=已产生、推算出=预计', () => {
    setToday()
    renderCard({
      records: [
        record({ id: 'f', exDate: '2026-06-20' }),
        record({ id: 'p', exDate: '2026-06-02' }),
        record({ id: 'e', code: '000002', exDate: '2026-03-15', frequency: 'quarterly' }), // → 预计 06-15
      ],
    })
    expect(screen.getByTestId('dividend-calendar')).toBeTruthy()
    expect(screen.getByTestId('dividend-day-2026-06-20').getAttribute('data-mark')).toBe('confirmed')
    expect(screen.getByTestId('dividend-day-2026-06-02').getAttribute('data-mark')).toBe('produced')
    expect(screen.getByTestId('dividend-day-2026-06-15').getAttribute('data-mark')).toBe('estimated')
    // 没有分红的日子不打标记
    expect(screen.getByTestId('dividend-day-2026-06-05').getAttribute('data-mark')).toBeNull()
  })

  it('汇总行显示本月预估到账（份额 × 税后）', () => {
    setToday()
    renderCard({ records: [record()] }) // 100 份 × 5 元 = 500
    expect(screen.getByTestId('dividend-home-card').textContent).toContain('500.00')
    expect(screen.getByTestId('dividend-home-card').textContent).toContain('已确认 1 笔')
  })

  it('可以翻月，并能一键回到本月', () => {
    setToday()
    renderCard({ records: [record()] })
    fireEvent.click(screen.getByTestId('dividend-cal-next'))
    expect(screen.getByTestId('dividend-calendar').textContent).toContain('2026 年 7 月')
    fireEvent.click(screen.getByTestId('dividend-cal-next'))
    expect(screen.getByTestId('dividend-calendar').textContent).toContain('2026 年 8 月')
    fireEvent.click(screen.getByTestId('dividend-cal-today'))
    expect(screen.getByTestId('dividend-calendar').textContent).toContain('2026 年 6 月')
  })

  it('点某天 → 显示当天明细；「看全部」恢复', () => {
    setToday()
    renderCard({ records: [record({ id: 'f', exDate: '2026-06-20' }), record({ id: 'p', exDate: '2026-06-02' })] })
    fireEvent.click(screen.getByTestId('dividend-day-2026-06-20'))
    expect(screen.getByText(/2026-06-20 的分红（1 笔）/)).toBeTruthy()
    expect(screen.getByTestId('dividend-row-f')).toBeTruthy()
    expect(screen.queryByTestId('dividend-row-p')).toBeNull()

    fireEvent.click(screen.getByTestId('dividend-home-clearday'))
    expect(screen.queryByText(/的分红（/)).toBeNull()
    expect(screen.getByTestId('dividend-home-period-month')).toBeTruthy()
  })

  it('没有分红的日期点开后提示「这天没有分红记录」', () => {
    setToday()
    renderCard({ records: [record()] })
    fireEvent.click(screen.getByTestId('dividend-day-2026-06-05'))
    expect(screen.getByText('这天没有分红记录。')).toBeTruthy()
  })

  it('已产生明细可按 本月 / 本季 / 本年 切换', () => {
    setToday()
    renderCard({
      records: [
        record({ id: 'jun', exDate: '2026-06-02' }),
        record({ id: 'may', exDate: '2026-05-02' }),
        record({ id: 'feb', exDate: '2026-02-02' }),
      ],
    })
    expect(screen.getByTestId('dividend-row-jun')).toBeTruthy()
    expect(screen.queryByTestId('dividend-row-may')).toBeNull() // 本月以外不显示

    fireEvent.click(screen.getByTestId('dividend-home-period-quarter'))
    expect(screen.getByTestId('dividend-row-jun')).toBeTruthy()
    expect(screen.getByTestId('dividend-row-may')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dividend-home-period-year'))
    expect(screen.getByTestId('dividend-row-feb')).toBeTruthy()
  })

  it('一条记录都没有时：日历照显示，底部提示未录入分红信息', () => {
    setToday()
    renderCard()
    expect(screen.getByTestId('dividend-calendar')).toBeTruthy()
    expect(screen.getByTestId('dividend-home-empty').textContent).toContain('未录入分红信息')
  })

  it('没设默认账户时：提示并回调打开设置', () => {
    setToday()
    const onNeedCashAccount = vi.fn()
    const notify = vi.fn()
    const applyCash = vi.fn(() => ({ ok: true }))
    render(
      <DividendHomeCard
        portfolio={portfolio}
        dividends={makeDividends({ records: [record()], applyCash })}
        rates={null}
        dividendSettings={createDefaultSettings().dividends}
        notify={notify}
        onOpenAll={vi.fn()}
        onNeedCashAccount={onNeedCashAccount}
      />,
    )
    // 未来的已确认分红要点开当天才出现在明细里
    fireEvent.click(screen.getByTestId('dividend-day-2026-06-20'))
    fireEvent.click(screen.getByTestId('dividend-cash-r1'))
    expect(notify).toHaveBeenCalledWith('请先选择默认入账账户', 'error')
    expect(onNeedCashAccount).toHaveBeenCalledTimes(1)
    expect(applyCash).not.toHaveBeenCalled()
  })

  it('卡片里可以直接现金入账（和设置页共用同一个行组件）', () => {
    setToday()
    const target = { categoryId: 'cat_cash', itemId: 'c1', itemName: '招行活期' }
    const applyCash = vi.fn(
      (_record: DividendRecord, _target: { categoryId: string; itemId: string; itemName: string }) => ({
        ok: true,
        message: '已入账 500 元',
      }),
    )
    const notify = vi.fn()
    render(
      <DividendHomeCard
        portfolio={portfolio}
        dividends={makeDividends({ records: [record()], applyCash })}
        rates={null}
        dividendSettings={{ ...createDefaultSettings().dividends, defaultCashTarget: target }}
        notify={notify}
        onOpenAll={vi.fn()}
        onNeedCashAccount={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('dividend-day-2026-06-20'))
    fireEvent.click(screen.getByTestId('dividend-cash-r1'))
    expect(applyCash).toHaveBeenCalledTimes(1)
    expect(applyCash.mock.calls[0][1]).toEqual(target)
    expect(notify).toHaveBeenCalledWith('已入账 500 元', 'success')
  })

  it('「查看全部」回调给上层（用于跳设置里的分红页）', () => {
    setToday()
    const { onOpenAll } = renderCard({ records: [record()] })
    fireEvent.click(screen.getByTestId('dividend-home-open'))
    expect(onOpenAll).toHaveBeenCalledTimes(1)
  })
})
