// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category } from '../types/asset'
import { BUILTIN_STRATEGIES } from '../lib/strategies'
import ItemMappingSheet from './ItemMappingSheet'

const aw = BUILTIN_STRATEGIES.find((s) => s.id === 'all-weather')!

const category: Category = {
  id: 'cat_fund',
  name: '基金',
  subtitle: '',
  icon: 'x',
  color: '#888',
  items: [],
}
const item: AssetItem = {
  id: 'f1',
  kind: 'fund',
  name: '易方达裕丰回报债券',
  code: '000171',
  shares: 1000,
  costNav: 1,
} as AssetItem

const renderSheet = (opts: { rule?: Record<string, unknown>; autoMix?: Record<string, number> } = {}) => {
  const onSave = vi.fn()
  const notify = vi.fn()
  const onClose = vi.fn()
  render(
    <ItemMappingSheet
      open
      onClose={onClose}
      item={item}
      category={category}
      strategy={aw}
      autoMix={(opts.autoMix ?? { equity: 0.19, bond: 0.81 }) as never}
      mixInfo={{ reportDate: '2026-06-30', ftype: '债券型-混合二级' }}
      rule={opts.rule as never}
      value={100000}
      onSave={onSave}
      notify={notify}
    />,
  )
  return { onSave, notify, onClose }
}

afterEach(cleanup)

describe('单笔资产的映射弹窗', () => {
  it('显示当前来源（穿透）与占比明细、报告期', () => {
    renderSheet()
    expect(screen.getByTestId('mapping-source').textContent).toBe('自动·穿透')
    expect(screen.getByTestId('mapping-mix').textContent).toContain('股票 19%')
    expect(screen.getByTestId('mapping-mix').textContent).toContain('债券 81%')
    expect(screen.getByTestId('item-mapping-sheet').textContent).toContain('2026-06-30')
  })

  it('手动指定：自己分割为 40% 股票 / 60% 中期国债', () => {
    const { onSave, notify, onClose } = renderSheet()
    fireEvent.click(screen.getByTestId('mapping-mode-manual'))
    fireEvent.change(screen.getByTestId('mapping-percent-stock'), { target: { value: '40' } })
    fireEvent.change(screen.getByTestId('mapping-percent-bond-mid'), { target: { value: '60' } })
    fireEvent.click(screen.getByTestId('mapping-save'))

    expect(onSave).toHaveBeenCalledTimes(1)
    const rule = onSave.mock.calls[0][0]
    expect(rule.source).toBe('manual')
    expect(rule.entries).toEqual([
      { strategyClassId: 'stock', percent: 40 },
      { strategyClassId: 'bond-mid', percent: 60 },
    ])
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('已保存'), 'success')
    expect(onClose).toHaveBeenCalled()
  })

  it('可以选债券期限（长期）并一起保存', () => {
    const { onSave } = renderSheet()
    fireEvent.click(screen.getByTestId('mapping-mode-manual'))
    fireEvent.change(screen.getByTestId('mapping-percent-bond-long'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('mapping-term-long'))
    fireEvent.click(screen.getByTestId('mapping-save'))
    expect(onSave.mock.calls[0][0].bondTerm).toBe('long')
    expect(onSave.mock.calls[0][0].entries).toEqual([{ strategyClassId: 'bond-long', percent: 100 }])
  })

  it('不纳入配置：保存 excluded', () => {
    const { onSave, notify } = renderSheet()
    fireEvent.click(screen.getByTestId('mapping-mode-excluded'))
    fireEvent.click(screen.getByTestId('mapping-save'))
    expect(onSave.mock.calls[0][0]).toMatchObject({ excluded: true, source: 'manual' })
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('不纳入配置'), 'success')
  })

  it('恢复自动识别：保存 undefined', () => {
    const { onSave } = renderSheet({ rule: { entries: [{ strategyClassId: 'stock', percent: 100 }], source: 'manual' } })
    fireEvent.click(screen.getByTestId('mapping-restore'))
    expect(onSave).toHaveBeenCalledWith(undefined)
  })

  it('手动模式一个比例都没填时拒绝保存', () => {
    const { onSave, notify } = renderSheet()
    fireEvent.click(screen.getByTestId('mapping-mode-manual'))
    fireEvent.click(screen.getByTestId('mapping-save'))
    expect(onSave).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('至少给一个'), 'error')
  })

  it('「按当前识别填」按穿透结果预填', () => {
    renderSheet()
    fireEvent.click(screen.getByTestId('mapping-mode-manual'))
    fireEvent.click(screen.getByText(/按当前识别填/))
    expect((screen.getByTestId('mapping-percent-bond-mid') as HTMLInputElement).value).toBe('81')
    expect((screen.getByTestId('mapping-percent-stock') as HTMLInputElement).value).toBe('19')
  })
})
