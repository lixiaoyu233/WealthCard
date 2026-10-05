// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category, Portfolio } from '../types/asset'
import DepositTargetPicker from './DepositTargetPicker'

const amount = (id: string, v: number): AssetItem => ({ id, kind: 'amount', name: id, amount: v })
const fund = (id: string): AssetItem => ({ id, kind: 'fund', name: id, code: '161725', shares: 1, costNav: 1 })
const cat = (id: string, name: string, items: AssetItem[]): Category => ({
  id,
  name,
  subtitle: '',
  icon: 'wallet',
  color: 'x',
  items,
})
const pf = (categories: Category[]): Portfolio => ({ version: 2, categories, history: [] })

afterEach(cleanup)

const renderPicker = (portfolio: Portfolio, onChange = vi.fn()) => {
  render(<DepositTargetPicker testId="target" portfolio={portfolio} onChange={onChange} />)
  return onChange
}

describe('入账目标选择框（薪资 / 分红共用）', () => {
  it('★ 余额为 0 的账户也能选 —— 用户报的「没有可选项」就是这个场景', () => {
    renderPicker(pf([cat('cat_cash', '现金与固定资产', [amount('招行活期', 0)])]))
    const select = screen.getByTestId('target') as HTMLSelectElement
    expect(select.options).toHaveLength(2) // 「请选择账户」+ 招行活期
    expect(screen.getByRole('option', { name: /招行活期/ })).toBeTruthy()
  })

  it('余额为负也能选（信用卡）', () => {
    renderPicker(pf([cat('cat_cash', '现金与固定资产', [amount('信用卡', -200)])]))
    expect(screen.getByRole('option', { name: /信用卡/ })).toBeTruthy()
  })

  it('其他分类的条目不会出现（只列「现金与固定资产」）', () => {
    renderPicker(
      pf([
        cat('cat_cash', '现金与固定资产', [amount('招行活期', 100)]),
        cat('cat_diy', '我的钱包', [amount('微信零钱', 50)]),
      ]),
    )
    expect(screen.queryByRole('option', { name: /微信零钱/ })).toBeNull()
    expect(screen.getByRole('option', { name: /招行活期/ })).toBeTruthy()
  })

  it('分类不存在时，空状态说清「去哪加」', () => {
    renderPicker(pf([]))
    const empty = screen.getByTestId('target-empty')
    expect(empty.textContent).toContain('现金与固定资产')
    expect(empty.textContent).toContain('金额类条目')
  })

  it('分类存在但只有基金/黄金条目时，空状态说明原因（不是金额类）', () => {
    renderPicker(pf([cat('cat_cash', '现金与固定资产', [fund('某基金')])]))
    const empty = screen.getByTestId('target-empty')
    expect(empty.textContent).toContain('1 个条目')
    expect(empty.textContent).toContain('金额类')
  })

  it('选择后回调带上分类与条目信息（用于记住默认账户）', () => {
    const onChange = renderPicker(pf([cat('cat_cash', '现金与固定资产', [amount('招行活期', 0)])]))
    fireEvent.change(screen.getByTestId('target'), { target: { value: '招行活期' } })
    expect(onChange).toHaveBeenCalledWith({ categoryId: 'cat_cash', itemId: '招行活期', itemName: '招行活期' })
  })

  it('原来选的账户被删掉时会提示重新选择', () => {
    // value 指向一个不存在的条目
    render(
      <DepositTargetPicker
        testId="target"
        portfolio={pf([cat('cat_cash', '现金与固定资产', [amount('招行活期', 0)])])}
        value={{ categoryId: 'cat_cash', itemId: '已删除的账户', itemName: '已删除的账户' }}
        onChange={() => {}}
      />,
    )
    expect(screen.getByText(/已经不在了/)).toBeTruthy()
  })
})
