// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category } from '../types/asset'
import type { InstallmentPlan } from '../lib/installments'
import type { CashCandidate } from '../lib/settings'
import { createDefaultSettings } from '../lib/settings'
import ItemForm from './ItemForm'
import CategoryCard from './CategoryCard'

const noop = () => {}

const liability: Category = {
  id: 'cat_debt',
  name: '负债',
  subtitle: '',
  icon: 'x',
  color: 'x',
  isLiability: true,
  items: [],
}
const assetCat: Category = { ...liability, id: 'cat_cash', name: '现金与固定资产', isLiability: false }

const targets: CashCandidate[] = [
  { categoryId: 'cat_cash', categoryName: '现金与固定资产', itemId: 'c1', itemName: '招行活期', amount: 1000 },
]

const plan = (over: Partial<InstallmentPlan> = {}): InstallmentPlan => ({
  id: 'plan_d1',
  categoryId: 'cat_debt',
  itemId: 'd1',
  name: '房贷',
  remainingAmount: 120000,
  remainingTerms: 24,
  perTermAmount: 5000,
  interval: 'monthly',
  nextDueDate: '2026-07-10',
  firstDueDate: '2026-07-10',
  countFullAmount: false,
  fromAccount: { categoryId: 'cat_cash', itemId: 'c1', itemName: '招行活期' },
  paidTerms: 0,
  paidTotal: 0,
  createdAt: 1,
  ...over,
})

const planItem: AssetItem = { id: 'd1', kind: 'amount', name: '房贷', amount: 120000 }

const renderForm = (opts: { category?: Category; plan?: InstallmentPlan; initial?: AssetItem } = {}) => {
  const onSubmit = vi.fn()
  const onSubmitPlan = vi.fn()
  render(
    <ItemForm
      category={opts.category ?? liability}
      depositTargets={targets}
      plan={opts.plan}
      initial={opts.initial}
      onSubmit={onSubmit}
      onSubmitPlan={onSubmitPlan}
      onCancel={noop}
    />,
  )
  return { onSubmit, onSubmitPlan }
}

afterEach(cleanup)

describe('负债条目表单里的「定期划扣」', () => {
  it('只出现在负债分类；默认关闭，打开后才有字段', () => {
    const { unmount } = render(
      <ItemForm category={assetCat} depositTargets={targets} onSubmit={noop} onCancel={noop} />,
    )
    expect(screen.queryByTestId('installment-section')).toBeNull()
    unmount()

    renderForm()
    expect(screen.getByTestId('installment-section')).toBeTruthy()
    expect((screen.getByTestId('installment-toggle') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByTestId('plan-total')).toBeNull()

    fireEvent.click(screen.getByTestId('installment-toggle'))
    expect(screen.getByTestId('plan-total')).toBeTruthy()
    expect(screen.getByTestId('plan-terms')).toBeTruthy()
    expect(screen.getByTestId('plan-per')).toBeTruthy()
  })

  it('填两样自动算第三样：总额 + 期数 → 每期', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('installment-toggle'))
    fireEvent.change(screen.getByTestId('plan-total'), { target: { value: '120000' } })
    fireEvent.change(screen.getByTestId('plan-terms'), { target: { value: '24' } })
    expect((screen.getByTestId('plan-per') as HTMLInputElement).value).toBe('5000')
  })

  it('除不尽时四舍五入，并提示最后一期兜差', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('installment-toggle'))
    fireEvent.change(screen.getByTestId('plan-total'), { target: { value: '1000' } })
    fireEvent.change(screen.getByTestId('plan-terms'), { target: { value: '3' } })
    expect((screen.getByTestId('plan-per') as HTMLInputElement).value).toBe('333.33')
    expect(screen.getByTestId('installment-section').textContent).toContain('最后一期')
  })

  it('改期数或每期金额会重算总额（三者始终自洽）', () => {
    renderForm()
    fireEvent.click(screen.getByTestId('installment-toggle'))
    fireEvent.change(screen.getByTestId('plan-per'), { target: { value: '500' } })
    fireEvent.change(screen.getByTestId('plan-terms'), { target: { value: '12' } })
    expect((screen.getByTestId('plan-total') as HTMLInputElement).value).toBe('6000')
  })

  it('保存时把计划交给上层（含账户、周期、计入方式开关）', () => {
    const { onSubmit, onSubmitPlan } = renderForm()
    fireEvent.click(screen.getByTestId('installment-toggle'))
    fireEvent.change(screen.getByTestId('plan-name'), { target: { value: '房贷' } })
    fireEvent.change(screen.getByTestId('plan-total'), { target: { value: '120000' } })
    fireEvent.change(screen.getByTestId('plan-terms'), { target: { value: '24' } })
    fireEvent.change(screen.getByTestId('plan-account'), { target: { value: 'cat_cash:c1' } })
    fireEvent.change(screen.getByTestId('plan-interval'), { target: { value: 'quarterly' } })
    fireEvent.click(screen.getByTestId('plan-count-full'))
    fireEvent.click(screen.getByText('添加'))

    expect(onSubmitPlan).toHaveBeenCalledTimes(1)
    const [itemId, saved, enabled] = onSubmitPlan.mock.calls[0]
    expect(enabled).toBe(true)
    expect(itemId).toBe(onSubmit.mock.calls[0][0].id)
    expect(saved).toMatchObject({
      name: '房贷',
      remainingAmount: 120000,
      remainingTerms: 24,
      perTermAmount: 5000,
      interval: 'quarterly',
      countFullAmount: true,
      fromAccount: { categoryId: 'cat_cash', itemId: 'c1', itemName: '招行活期' },
    })
  })

  it('没有扣款账户时不保存，给出提示', () => {
    const { onSubmitPlan } = renderForm({ category: { ...liability } })
    fireEvent.click(screen.getByTestId('installment-toggle'))
    fireEvent.change(screen.getByTestId('plan-total'), { target: { value: '1200' } })
    fireEvent.change(screen.getByTestId('plan-terms'), { target: { value: '12' } })
    fireEvent.click(screen.getByText('添加'))
    expect(onSubmitPlan).not.toHaveBeenCalled()
    expect(screen.getByText(/请选择扣款账户/)).toBeTruthy()
  })

  it('编辑时预填当前剩余数字，取消勾选即关掉计划', () => {
    // 编辑态：条目上已经有计划维护的金额
    const { onSubmitPlan } = renderForm({ plan: plan(), initial: planItem })
    const toggle = screen.getByTestId('installment-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect((screen.getByTestId('plan-total') as HTMLInputElement).value).toBe('120000')
    expect((screen.getByTestId('plan-terms') as HTMLInputElement).value).toBe('24')
    expect((screen.getByTestId('plan-per') as HTMLInputElement).value).toBe('5000')

    fireEvent.click(toggle)
    fireEvent.click(screen.getByText('保存修改')) // 编辑态的按钮文案
    expect(onSubmitPlan).toHaveBeenCalledWith('d1', null, false)
  })
})

describe('负债卡片上的到期提醒', () => {
  const card = (props: { dueReminders?: number; planMonthly?: number }) =>
    render(
      <CategoryCard
        category={liability}
        rates={null}
        dueReminders={props.dueReminders}
        planMonthly={props.planMonthly}
        onOpen={noop}
      />,
    )

  it('到期未处理：亮红点 + 「待确认还款（N 期）」', () => {
    card({ dueReminders: 2, planMonthly: 5000 })
    const el = screen.getByTestId('category-plan-due-cat_debt')
    expect(el.textContent).toContain('待确认还款')
    expect(el.textContent).toContain('2 期')
    expect(el.textContent).toContain('每月 5,000.00 元')
  })

  it('没到期时只安静地显示每月还款合计', () => {
    card({ dueReminders: 0, planMonthly: 5000 })
    expect(screen.queryByTestId('category-plan-due-cat_debt')).toBeNull()
    expect(screen.getByText(/定期划扣 · 每月/)).toBeTruthy()
  })

  it('没有分期计划时卡片上不出现任何划扣信息', () => {
    card({})
    expect(screen.queryByText(/定期划扣/)).toBeNull()
  })
})

// 让 lint 满意：这些是从设置里拿的默认值，用于后续扩展断言
void createDefaultSettings
