// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category, Portfolio } from '../types/asset'
import { createDefaultSettings } from '../lib/settings'
import type { DividendRecord } from '../lib/dividends'
import { makeDividends } from '../test/fixtures'
import DividendPanel from './DividendPanel'

const fund = (
  id: string,
  code: string,
  market: 'cn' | 'ashare' | 'us' | 'hk',
  shares = 1000,
  costNav = 1,
): AssetItem => ({ id, kind: 'fund', name: `持仓-${code}`, code, market, shares, costNav })
const gold: AssetItem = { id: 'g1', kind: 'gold', name: '积存金', grams: 10, pricePerGram: 500 }
const cash: AssetItem = { id: 'c1', kind: 'amount', name: '招行活期', amount: 0 }
const cat = (id: string, items: AssetItem[]): Category => ({ id, name: id, subtitle: '', icon: 'x', color: 'x', items })

const portfolio: Portfolio = {
  version: 2,
  categories: [
    cat('cat_cash', [cash]),
    cat('cat_stock', [fund('i1', '600519', 'ashare'), fund('i2', 'SPY', 'us'), fund('i3', '00700', 'hk')]),
    cat('cat_fund', [fund('i4', '161725', 'cn')]),
    cat('cat_gold', [gold]),
  ],
  history: [],
}

const record = (over: Partial<DividendRecord> = {}): DividendRecord => ({
  id: over.id ?? 'r1',
  code: '600519',
  market: 'ashare',
  name: '贵州茅台',
  exDate: '2026-06-20',
  cashPerUnit: 0.5,
  currency: 'CNY',
  frequency: 'annual',
  source: 'auto',
  ...over,
})

const settings = () => createDefaultSettings().dividends

const renderPanel = (opts: {
  records?: DividendRecord[]
  dividends?: ReturnType<typeof makeDividends>
  dividendSettings?: ReturnType<typeof settings>
  notify?: (t: string, tone?: 'success' | 'error' | 'info') => void
} = {}) => {
  const notify = opts.notify ?? vi.fn()
  const onSetDividendSettings = vi.fn()
  const dividends = opts.dividends ?? makeDividends({ records: opts.records ?? [] })
  render(
    <DividendPanel
      portfolio={portfolio}
      dividends={dividends}
      rates={null}
      dividendSettings={opts.dividendSettings ?? settings()}
      onSetDividendSettings={onSetDividendSettings}
      notify={notify}
    />,
  )
  return { notify, onSetDividendSettings, dividends }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('分红日历', () => {
  it('本月已确认：显示日期、税后每份金额与预估到账（份额 × 税后）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10)) // 2026-06-10
    renderPanel({ records: [record({ afterTaxPerUnit: 0.5 })] })
    expect(screen.getByText(/已确认（1）/)).toBeTruthy()
    expect(screen.getByText('贵州茅台')).toBeTruthy()
    // 1000 份 × 0.5 = 500.00
    expect(screen.getByTestId('dividend-row-r1').textContent).toContain('500.00')
  })

  it('预计段显示推算依据，且不提供入账按钮', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const past = record({ id: 'r0', exDate: '2026-03-15', frequency: 'quarterly' })
    renderPanel({ records: [past] })
    expect(screen.getByText(/按历史推算（1）/)).toBeTruthy()
    // 每季：03-15 → 06-15
    const estimateRow = screen.getByTestId('dividend-row-estimate_ashare:600519_2026-06-15')
    expect(estimateRow.textContent).toContain('2026-06-15')
    expect(screen.getByText(/按周期推算/)).toBeTruthy()
    // 预计项只是预测，不给入账按钮
    expect(estimateRow.querySelector('button')).toBeNull()
    // 而那笔已经发生、还没入账的分红仍然出现在「已产生」里，可以补入账
    expect(screen.getByTestId('dividend-cash-r0')).toBeTruthy()
  })

  it('已产生：按「今年/本季/本月」汇总并给合计', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    renderPanel({ records: [record({ id: 'r1', exDate: '2026-06-01', afterTaxPerUnit: 0.5 })] })
    expect(screen.getByTestId('dividend-produced-total').textContent).toContain('500.00')
    fireEvent.click(screen.getByTestId('dividend-period-month'))
    expect(screen.getByTestId('dividend-produced-total').textContent).toContain('1 笔')
  })
})

describe('入账动作', () => {
  it('现金入账调用 applyCash，并带上默认账户', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const applyCash = vi.fn((_record: DividendRecord, _target: { categoryId: string; itemId: string; itemName: string }) => ({
      ok: true,
      message: '已入账 500 元',
    }))
    const target = { categoryId: 'cat_cash', itemId: 'c1', itemName: '招行活期' }
    const notify = vi.fn()
    renderPanel({
      records: [record()],
      dividends: makeDividends({ records: [record()], applyCash }),
      dividendSettings: { ...settings(), defaultCashTarget: target },
      notify,
    })
    fireEvent.click(screen.getByTestId('dividend-cash-r1'))
    expect(applyCash).toHaveBeenCalledTimes(1)
    expect(applyCash.mock.calls[0][1]).toEqual(target)
    expect(notify).toHaveBeenCalledWith('已入账 500 元', 'success')
  })

  it('没有默认账户时给提示并跳到「分红设置」', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const notify = vi.fn()
    renderPanel({ records: [record()], notify })
    fireEvent.click(screen.getByTestId('dividend-cash-r1'))
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('默认入账账户'), 'error')
    expect(screen.getByTestId('dividend-tax-us')).toBeTruthy() // 已切到设置页
  })

  it('再投资需要填价格；送转按钮只在有比例时出现', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const applyReinvest = vi.fn(() => ({ ok: true, message: '已增加 100 份' }))
    renderPanel({
      records: [record({ mode: 'reinvest', bonusRatio: 4 })],
      dividends: makeDividends({ records: [record({ mode: 'reinvest', bonusRatio: 4 })], applyReinvest }),
    })
    fireEvent.change(screen.getByTestId('dividend-price-r1'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('dividend-reinvest-r1'))
    expect(applyReinvest).toHaveBeenCalledWith(expect.anything(), 5)
    expect(screen.getByTestId('dividend-bonus-r1').textContent).toContain('10 送转 4')
  })
})

describe('待补录', () => {
  it('列出没有分红记录的基金/A股/港股/美股，黄金与纯金额不列', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('dividend-tab-pending'))
    for (const code of ['600519', 'SPY', '00700', '161725']) {
      expect(screen.getByTestId('dividend-entry-' + code)).toBeTruthy()
    }
    expect(screen.queryByText('积存金')).toBeNull()
    expect(screen.queryByText('招行活期')).toBeNull()
    // A股标注自动源未命中，其余标注暂无自动源
    expect(screen.getByText(/自动源未命中/)).toBeTruthy()
    expect(screen.getAllByText(/暂无自动源/)).toHaveLength(3)
  })

  it('已有分红记录的标的不会再出现在待补录里', () => {
    renderPanel({ records: [record({ code: '600519' })] })
    fireEvent.click(screen.getByTestId('dividend-tab-pending'))
    expect(screen.queryByTestId('dividend-entry-600519')).toBeNull()
    expect(screen.getByTestId('dividend-entry-SPY')).toBeTruthy()
  })

  it('录入表单会按标的预填市场/币种，保存后回调 addManual', () => {
    const addManual = vi.fn()
    renderPanel({ dividends: makeDividends({ addManual }) })
    fireEvent.click(screen.getByTestId('dividend-tab-pending'))
    fireEvent.click(screen.getByTestId('dividend-entry-SPY'))
    expect(screen.getByTestId('dividend-form')).toBeTruthy()
    expect(screen.getByTestId('dividend-form').textContent).toContain('美股')

    fireEvent.change(screen.getByTestId('dividend-exdate'), { target: { value: '2026-06-20' } })
    fireEvent.change(screen.getByTestId('dividend-amount'), { target: { value: '0.25' } })
    fireEvent.click(screen.getByTestId('dividend-save'))

    expect(addManual).toHaveBeenCalledTimes(1)
    expect(addManual.mock.calls[0][0]).toMatchObject({
      code: 'SPY',
      market: 'us',
      currency: 'USD',
      exDate: '2026-06-20',
      cashPerUnit: 0.25,
      source: 'manual',
    })
  })

  it('金额为空或日期没填时不保存，给出提示', () => {
    const addManual = vi.fn()
    renderPanel({ dividends: makeDividends({ addManual }) })
    fireEvent.click(screen.getByTestId('dividend-tab-pending'))
    fireEvent.click(screen.getByTestId('dividend-entry-SPY'))
    fireEvent.click(screen.getByTestId('dividend-save'))
    expect(addManual).not.toHaveBeenCalled()
    expect(screen.getByTestId('dividend-form-error')).toBeTruthy()
  })
})

describe('分红设置', () => {
  it('税率按百分比编辑并换算回 0~1', () => {
    const { onSetDividendSettings } = renderPanel()
    fireEvent.click(screen.getByTestId('dividend-tab-settings'))
    const us = screen.getByTestId('dividend-tax-us') as HTMLInputElement
    expect(us.value).toBe('10')
    fireEvent.change(us, { target: { value: '30' } })
    expect(onSetDividendSettings).toHaveBeenCalledWith({ usTaxRate: 0.3 })
  })
})


describe('已入账 / 持仓已删除的分红也能删掉', () => {
  const orphanRecord = record({
    id: 'gone',
    code: '000858', // 组合里没有这只
    market: 'ashare',
    applied: true,
    appliedAt: 1,
  })

  it('已入账的孤儿记录：显示已入账、提示持仓已删除、并给出删除按钮', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    renderPanel({ records: [orphanRecord] })
    expect(screen.getByTestId('dividend-row-gone').textContent).toContain('已入账')
    expect(screen.getByTestId('dividend-row-gone').textContent).toContain('对应持仓已删除')
    expect(screen.getByTestId('dividend-delete-gone')).toBeTruthy()
  })

  it('删除前二次确认，文案说明「已入账的钱不退」', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const remove = vi.fn()
    renderPanel({ records: [orphanRecord], dividends: makeDividends({ records: [orphanRecord], remove }) })
    fireEvent.click(screen.getByTestId('dividend-delete-gone'))
    expect(screen.getByText('删除这条分红？')).toBeTruthy()
    expect(screen.getByText(/已入账的金额不会退回/)).toBeTruthy()
    fireEvent.click(screen.getByText('删除'))
    expect(remove).toHaveBeenCalledWith('gone')
  })

  it('顶部提示条 + 「全部清理」一次删掉所有失效记录', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const records = [orphanRecord, record({ id: 'gone2', code: '000859', market: 'ashare' })]
    const remove = vi.fn()
    renderPanel({ records, dividends: makeDividends({ records, remove }) })
    expect(screen.getByTestId('dividend-orphan-bar').textContent).toContain('2 条')
    fireEvent.click(screen.getByTestId('dividend-cleanup-orphans'))
    fireEvent.click(screen.getByText('确认清理'))
    expect(remove).toHaveBeenCalledWith('gone')
    expect(remove).toHaveBeenCalledWith('gone2')
  })

  it('未入账的手动记录也能删（以前只有手动记录才有删除按钮，自动的没有）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 10))
    const auto = record({ id: 'auto1', code: '600519', market: 'ashare', source: 'auto' })
    renderPanel({ records: [auto] })
    expect(screen.getByTestId('dividend-delete-auto1')).toBeTruthy()
  })
})
