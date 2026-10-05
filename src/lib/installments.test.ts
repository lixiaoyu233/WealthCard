import { describe, expect, it } from 'vitest'
import type { AssetItem, Category, Portfolio } from '../types/asset'
import {
  type InstallmentPlan,
  createEmptyInstallmentFile,
  deriveInstallment,
  duePeriodCount,
  isDue,
  liabilityIncludedAmount,
  monthlyPressure,
  monthlyTotal,
  normalizeInstallmentFile,
  payInstallmentTerm,
  syncInstallmentAmounts,
  totalLiability,
  withdrawFromCashItem,
} from './installments'

const amount = (id: string, v: number): AssetItem => ({ id, kind: 'amount', name: id, amount: v })
const cat = (id: string, items: AssetItem[], isLiability = false): Category => ({
  id,
  name: id,
  subtitle: '',
  icon: 'x',
  color: 'x',
  isLiability,
  items,
})
const pf = (categories: Category[]): Portfolio => ({ version: 2, categories, history: [] })

const plan = (over: Partial<InstallmentPlan> = {}): InstallmentPlan => ({
  id: over.id ?? 'p1',
  categoryId: over.categoryId ?? 'cat_debt',
  itemId: over.itemId ?? 'd1',
  name: over.name ?? '手机分期',
  remainingAmount: over.remainingAmount ?? 6000,
  remainingTerms: over.remainingTerms ?? 6,
  perTermAmount: over.perTermAmount ?? 1000,
  interval: over.interval ?? 'monthly',
  nextDueDate: over.nextDueDate ?? '2026-06-10',
  firstDueDate: over.firstDueDate ?? '2026-06-10',
  countFullAmount: over.countFullAmount ?? false,
  fromAccount: over.fromAccount ?? { categoryId: 'cat_cash', itemId: 'c1', itemName: '招行活期' },
  paidTerms: over.paidTerms ?? 0,
  paidTotal: over.paidTotal ?? 0,
  createdAt: over.createdAt ?? 1,
})

describe('deriveInstallment：填两样算第三样', () => {
  it('总额 + 期数 → 每期金额（四舍五入）', () => {
    const r = deriveInstallment({ totalAmount: 6000, terms: 12 })
    expect(r.ok).toBe(true)
    expect(r.perTermAmount).toBe(500)
    expect(r.rounded).toBe(false)
  })
  it('除不尽时四舍五入并标记 rounded（最后一期兜差）', () => {
    const r = deriveInstallment({ totalAmount: 1000, terms: 3 })
    expect(r.perTermAmount).toBe(333.33)
    expect(r.rounded).toBe(true)
  })
  it('总额 + 每期金额 → 期数', () => {
    const r = deriveInstallment({ totalAmount: 6000, perTermAmount: 500 })
    expect(r.terms).toBe(12)
  })
  it('期数 + 每期金额 → 总额', () => {
    const r = deriveInstallment({ terms: 24, perTermAmount: 250 })
    expect(r.totalAmount).toBe(6000)
    expect(r.perTermAmount).toBe(250)
  })
  it('只填一样 → 报错，不瞎猜', () => {
    expect(deriveInstallment({ totalAmount: 1000 }).ok).toBe(false)
    expect(deriveInstallment({ totalAmount: 1000 }).error).toBe('请填写其中两项')
    expect(deriveInstallment({ totalAmount: 0, terms: 0, perTermAmount: 0 }).ok).toBe(false)
  })
})

describe('负债口径：开关决定计入多少', () => {
  it('默认关闭 = 只把每期还款额计入', () => {
    expect(liabilityIncludedAmount(plan({ countFullAmount: false }))).toBe(1000)
  })
  it('打开 = 剩余欠款全额计入', () => {
    expect(liabilityIncludedAmount(plan({ countFullAmount: true }))).toBe(6000)
  })
  it('已结清的计划一律计 0（不留「幽灵负债」）', () => {
    expect(liabilityIncludedAmount(plan({ remainingTerms: 0 }))).toBe(0)
    expect(liabilityIncludedAmount(plan({ remainingTerms: 0, countFullAmount: true }))).toBe(0)
  })
})

describe('每月还款合计（每季 ÷3、每年 ÷12）', () => {
  it('月均折算', () => {
    expect(monthlyPressure(plan({ perTermAmount: 1000, interval: 'monthly' }))).toBe(1000)
    expect(monthlyPressure(plan({ perTermAmount: 3600, interval: 'quarterly' }))).toBe(1200)
    expect(monthlyPressure(plan({ perTermAmount: 12000, interval: 'yearly' }))).toBe(1000)
  })
  it('汇总多个计划，已结清的不算', () => {
    const total = monthlyTotal([
      plan({ id: 'a', perTermAmount: 1000, interval: 'monthly' }),
      plan({ id: 'b', perTermAmount: 3600, interval: 'quarterly' }),
      plan({ id: 'c', perTermAmount: 500, interval: 'monthly', remainingTerms: 0 }),
    ])
    expect(total).toBe(2200)
  })
})

describe('到期判断（不自动扣，只提示）', () => {
  it('未到期不计', () => {
    expect(duePeriodCount(plan({ nextDueDate: '2026-07-10' }), '2026-06-20')).toBe(0)
    expect(isDue(plan({ nextDueDate: '2026-07-10' }), '2026-06-20')).toBe(false)
  })
  it('当天到期算一起', () => {
    expect(duePeriodCount(plan({ nextDueDate: '2026-06-10' }), '2026-06-10')).toBe(1)
  })
  it('漏了多期就报多期（每月）', () => {
    expect(duePeriodCount(plan({ nextDueDate: '2026-04-10', remainingTerms: 6 }), '2026-06-20')).toBe(3)
  })
  it('每季度按 3 个月推进', () => {
    expect(duePeriodCount(plan({ nextDueDate: '2026-01-15', interval: 'quarterly', remainingTerms: 8 }), '2026-06-20')).toBe(2)
  })
  it('已结清永远不算到期；未处理期数不超过剩余期数', () => {
    expect(duePeriodCount(plan({ remainingTerms: 0 }), '2030-01-01')).toBe(0)
    expect(duePeriodCount(plan({ nextDueDate: '2020-01-01', remainingTerms: 2 }), '2030-01-01')).toBe(2)
  })
})

describe('扣款：现金可扣成负数，最后一期兜差', () => {
  const portfolio = pf([cat('cat_cash', [amount('c1', 1500)]), cat('cat_debt', [amount('d1', 6000)], true)])

  it('扣一期：现金 −每期、负债金额与期数递减、下次扣款日推进', () => {
    const r = payInstallmentTerm(portfolio, plan(), '2026-06-10')
    expect(r.ok).toBe(true)
    expect(r.amount).toBe(1000)
    const cashItem = r.portfolio.categories[0].items[0]
    expect(cashItem.kind === 'amount' && cashItem.amount).toBe(500)
    expect(r.plan.remainingAmount).toBe(5000)
    expect(r.plan.remainingTerms).toBe(5)
    expect(r.plan.nextDueDate).toBe('2026-07-10')
    expect(r.plan.paidTerms).toBe(1)
    expect(r.plan.paidTotal).toBe(1000)
    expect(r.plan.lastPaidDate).toBe('2026-06-10')
  })

  it('余额不足时允许扣成负数', () => {
    const poor = pf([cat('cat_cash', [amount('c1', 100)]), cat('cat_debt', [amount('d1', 6000)], true)])
    const r = payInstallmentTerm(poor, plan(), '2026-06-10')
    expect(r.ok).toBe(true)
    const cashItem = r.portfolio.categories[0].items[0]
    expect(cashItem.kind === 'amount' && cashItem.amount).toBe(-900)
  })

  it('最后一期按剩余金额兜差（除不尽不留零头）', () => {
    const last = plan({ remainingAmount: 333.34, remainingTerms: 1, perTermAmount: 333.33 })
    const r = payInstallmentTerm(portfolio, last, '2026-06-10')
    expect(r.amount).toBe(333.34)
    expect(r.plan.remainingAmount).toBe(0)
    expect(r.plan.remainingTerms).toBe(0)
  })

  it('已结清 / 账户不存在 / 非金额类账户 → 拒绝并给出原因', () => {
    expect(payInstallmentTerm(portfolio, plan({ remainingTerms: 0 }), '2026-06-10').ok).toBe(false)
    expect(
      payInstallmentTerm(portfolio, plan({ fromAccount: { categoryId: 'x', itemId: 'y', itemName: '不存在' } }), '2026-06-10')
        .reason,
    ).toContain('找不到扣款账户')
    const funded = pf([cat('cat_cash', [{ id: 'c1', kind: 'fund', name: 'c1', code: '161725', shares: 1, costNav: 1 }])])
    expect(payInstallmentTerm(funded, plan(), '2026-06-10').reason).toContain('金额类')
  })

  it('withdrawFromCashItem：金额非法直接拒绝', () => {
    expect(withdrawFromCashItem(portfolio, { categoryId: 'cat_cash', itemId: 'c1' }, 0).ok).toBe(false)
  })
})

describe('syncInstallmentAmounts：条目余额由计划维护', () => {
  const portfolio = pf([cat('cat_debt', [amount('d1', 9999)], true)])

  it('按开关把计划金额写进条目', () => {
    const synced = syncInstallmentAmounts(portfolio, [plan({ itemId: 'd1', countFullAmount: false })])
    const item = synced.categories[0].items[0]
    expect(item.kind === 'amount' && item.amount).toBe(1000)
  })

  it('计划结清后条目归零', () => {
    const synced = syncInstallmentAmounts(portfolio, [
      plan({ itemId: 'd1', remainingTerms: 0, countFullAmount: false }),
    ])
    const item = synced.categories[0].items[0]
    expect(item.kind === 'amount' && item.amount).toBe(0)
  })

  it('金额已经一致时返回原对象（避免无意义的重渲染/写盘）', () => {
    const already = pf([cat('cat_debt', [amount('d1', 1000)], true)])
    expect(syncInstallmentAmounts(already, [plan({ itemId: 'd1', countFullAmount: false })])).toBe(already)
  })
})

describe('totalLiability：手工负债 + 计划（不重复计算）', () => {
  it('有计划维护的条目不再单独累加', () => {
    const portfolio = pf([
      cat('cat_cash', [amount('c1', 100)]),
      cat('cat_debt', [amount('d1', 6000), amount('d2', 500)], true),
    ])
    const plans = [plan({ itemId: 'd1', remainingAmount: 6000, perTermAmount: 1000, countFullAmount: true })]
    // d1 由计划维护（跳过）→ 500 + 6000
    expect(totalLiability(portfolio, plans)).toBe(6500)
  })
  it('没有计划时就是手工负债合计', () => {
    const portfolio = pf([cat('cat_debt', [amount('d1', 6000), amount('d2', 500)], true)])
    expect(totalLiability(portfolio, [])).toBe(6500)
  })
})

describe('normalizeInstallmentFile：脏数据兜底', () => {
  it('缺账户/缺日期/缺 id 的计划被丢弃', () => {
    const file = normalizeInstallmentFile({
      plans: [
        { id: 'a', categoryId: 'c', itemId: 'i', nextDueDate: '2026-01-01' }, // 缺 fromAccount
        { id: 'b', categoryId: 'c', itemId: 'i', fromAccount: { categoryId: 'x', itemId: 'y' } }, // 缺日期
        { categoryId: 'c', itemId: 'i', nextDueDate: '2026-01-01', fromAccount: { categoryId: 'x', itemId: 'y' } }, // 缺 id
      ],
    })
    expect(file.plans).toHaveLength(0)
    expect(normalizeInstallmentFile(null)).toEqual(createEmptyInstallmentFile())
  })

  it('非法周期回落 monthly；开关非 true 一律 false；同 id 去重', () => {
    const raw = {
      plans: [
        {
          id: 'a',
          categoryId: 'c',
          itemId: 'i',
          nextDueDate: '2026-01-01',
          interval: 'weekly',
          countFullAmount: 'yes',
          fromAccount: { categoryId: 'x', itemId: 'y' },
        },
        {
          id: 'a',
          categoryId: 'c',
          itemId: 'i',
          name: '后一条',
          nextDueDate: '2026-02-01',
          fromAccount: { categoryId: 'x', itemId: 'y' },
        },
      ],
    }
    const file = normalizeInstallmentFile(raw)
    expect(file.plans).toHaveLength(1)
    expect(file.plans[0].name).toBe('后一条')
    expect(file.plans[0].interval).toBe('monthly')
    expect(file.plans[0].countFullAmount).toBe(false)
  })
})
