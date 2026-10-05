/**
 * 定期划扣（分期 / 贷款）——**不含利息**的简化账本。
 *
 * 口径（与用户确认过）：
 * - 「欠款总额 / 期数 / 每期金额」填两样，第三样自动（四舍五入），三者内部自洽；
 * - 周期只支持 每月 / 每季度 / 每年；
 * - **不自动扣**：到期只在界面提示，用户点「确认扣款」才扣（一次扣一期）；
 * - 扣款允许把现金账户扣成负数（信用卡等场景）；
 * - 每个计划一个开关：默认「只把每期还款额计入负债总额」，打开则「剩余欠款全额计入」；
 * - 提前还款不做 —— 要提前还就直接改「负债金额 / 剩余期数」。
 *
 * 存储独立成键，与持仓数据互不影响。
 */
import type { Portfolio } from '../types/asset'
import { safeNum } from './calc'
import { addMonths } from './dividendCalendar'
import { roundMoney } from './dividends'
import type { FundingSource } from './settings'

export const INSTALLMENTS_STORAGE_KEY = 'asset-card-wallet/installments/v1'

export type InstallmentInterval = 'monthly' | 'quarterly' | 'yearly'

export const INTERVAL_LABEL: Record<InstallmentInterval, string> = {
  monthly: '每月',
  quarterly: '每季度',
  yearly: '每年',
}

/** 一个周期等于几个月（用于折算「月均还款」） */
export const INTERVAL_MONTHS: Record<InstallmentInterval, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

export interface InstallmentPlan {
  id: string
  /** 挂在哪个负债条目上 */
  categoryId: string
  itemId: string
  name: string
  /** 负债金额（剩余欠款），随扣款递减 */
  remainingAmount: number
  /** 剩余期数，随扣款递减 */
  remainingTerms: number
  /** 每期金额 */
  perTermAmount: number
  interval: InstallmentInterval
  /** 下次扣款日 YYYY-MM-DD */
  nextDueDate: string
  /** 首次扣款日（仅展示用） */
  firstDueDate: string
  /**
   * 是否把「剩余欠款」全额计入负债总额。
   * false（默认）= 只把「每期还款额」计入负债总额。
   */
  countFullAmount: boolean
  /** 从哪个现金账户扣 */
  fromAccount: FundingSource
  /** 已扣统计（展示用，不参与计算） */
  paidTerms: number
  paidTotal: number
  lastPaidDate?: string
  createdAt: number
}

export interface InstallmentFile {
  version: 1
  plans: InstallmentPlan[]
}

export function createEmptyInstallmentFile(): InstallmentFile {
  return { version: 1, plans: [] }
}

/* ------------------------------------------------------------------ *
 * 三样填两样：欠款总额 / 期数 / 每期金额
 * ------------------------------------------------------------------ */

export interface InstallmentDraft {
  totalAmount?: number
  terms?: number
  perTermAmount?: number
}

export interface DeriveResult {
  totalAmount: number
  terms: number
  perTermAmount: number
  /** 除不尽时的兜差提示（最后一期金额不同） */
  rounded: boolean
  ok: boolean
  error?: string
}

/**
 * 三个数字里填两样，算出第三样（四舍五入）。
 * 按「欠款总额 = 每期金额 × 期数」保持自洽。
 */
export function deriveInstallment(draft: InstallmentDraft): DeriveResult {
  const total = Number(draft.totalAmount)
  const terms = Number(draft.terms)
  const per = Number(draft.perTermAmount)
  const hasTotal = Number.isFinite(total) && total > 0
  const hasTerms = Number.isFinite(terms) && terms > 0
  const hasPer = Number.isFinite(per) && per > 0
  const filled = [hasTotal, hasTerms, hasPer].filter(Boolean).length

  if (filled < 2) {
    return { totalAmount: 0, terms: 0, perTermAmount: 0, rounded: false, ok: false, error: '请填写其中两项' }
  }

  if (!hasPer) {
    const perCalc = roundMoney(total / terms)
    return {
      totalAmount: roundMoney(total),
      terms: Math.round(terms),
      perTermAmount: perCalc,
      rounded: Math.abs(perCalc * Math.round(terms) - total) > 0.005,
      ok: true,
    }
  }
  if (!hasTotal) {
    return {
      totalAmount: roundMoney(per * terms),
      terms: Math.round(terms),
      perTermAmount: roundMoney(per),
      rounded: false,
      ok: true,
    }
  }
  // 有总额 + 每期金额 → 推期数
  const termsCalc = Math.max(1, Math.round(total / per))
  return {
    totalAmount: roundMoney(total),
    terms: termsCalc,
    perTermAmount: roundMoney(per),
    rounded: Math.abs(per * termsCalc - total) > 0.005,
    ok: true,
  }
}

/* ------------------------------------------------------------------ *
 * 计算
 * ------------------------------------------------------------------ */

/**
 * 该计划计入「负债总额」的金额（开关决定口径）。
 * 已结清（剩余期数 0）的计划一律计 0 —— 否则会在条目上留下一个"幽灵负债"。
 */
export function liabilityIncludedAmount(plan: InstallmentPlan): number {
  if (!isActive(plan)) return 0
  return plan.countFullAmount ? plan.remainingAmount : plan.perTermAmount
}

/** 折算成月均还款（每季 ÷3、每年 ÷12） */
export function monthlyPressure(plan: InstallmentPlan): number {
  return roundMoney(plan.perTermAmount / INTERVAL_MONTHS[plan.interval])
}

/** 进行中的计划（还有剩余期数） */
export const isActive = (plan: InstallmentPlan): boolean => plan.remainingTerms > 0

/** 所有进行中计划的「每月还款合计」 */
export function monthlyTotal(plans: InstallmentPlan[]): number {
  return roundMoney(plans.filter(isActive).reduce((sum, plan) => sum + monthlyPressure(plan), 0))
}

/**
 * 已到期但还没处理的期数（只用于界面提示「有 N 期未处理」）。
 * **不自动补扣**：漏了几期就显示几期，由用户逐期确认或直接改计划。
 */
export function duePeriodCount(plan: InstallmentPlan, today: string): number {
  if (!isActive(plan)) return 0
  let count = 0
  let date = plan.nextDueDate
  // 上限就是剩余期数，避免脏数据把界面撑爆
  while (date <= today && count < plan.remainingTerms) {
    count += 1
    date = addMonths(date, INTERVAL_MONTHS[plan.interval])
  }
  return count
}

export const isDue = (plan: InstallmentPlan, today: string): boolean => duePeriodCount(plan, today) > 0

/* ------------------------------------------------------------------ *
 * 规范化 / 读写
 * ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const INTERVALS: InstallmentInterval[] = ['monthly', 'quarterly', 'yearly']

function normalizeSource(raw: unknown): FundingSource | undefined {
  if (!isRecord(raw)) return undefined
  const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId : ''
  const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
  if (!categoryId || !itemId) return undefined
  return { categoryId, itemId, itemName: typeof raw.itemName === 'string' ? raw.itemName : '现金项目' }
}

function normalizePlan(raw: unknown): InstallmentPlan | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
  const categoryId = typeof raw.categoryId === 'string' ? raw.categoryId : ''
  const nextDueDate = typeof raw.nextDueDate === 'string' ? raw.nextDueDate.slice(0, 10) : ''
  const fromAccount = normalizeSource(raw.fromAccount)
  if (!id || !itemId || !categoryId || !DATE_RE.test(nextDueDate) || !fromAccount) return null

  const remainingTerms = Math.max(0, Math.round(Number(raw.remainingTerms) || 0))
  const perTermAmount = Math.max(0, roundMoney(Number(raw.perTermAmount) || 0))
  const remainingAmount = Math.max(0, roundMoney(Number(raw.remainingAmount) || 0))
  const interval = INTERVALS.includes(raw.interval as InstallmentInterval)
    ? (raw.interval as InstallmentInterval)
    : 'monthly'

  return {
    id,
    categoryId,
    itemId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '分期',
    remainingAmount,
    remainingTerms,
    perTermAmount,
    interval,
    nextDueDate,
    firstDueDate: typeof raw.firstDueDate === 'string' && DATE_RE.test(raw.firstDueDate.slice(0, 10))
      ? raw.firstDueDate.slice(0, 10)
      : nextDueDate,
    countFullAmount: raw.countFullAmount === true,
    fromAccount,
    paidTerms: Math.max(0, Math.round(Number(raw.paidTerms) || 0)),
    paidTotal: Math.max(0, roundMoney(Number(raw.paidTotal) || 0)),
    lastPaidDate: typeof raw.lastPaidDate === 'string' && DATE_RE.test(raw.lastPaidDate.slice(0, 10))
      ? raw.lastPaidDate.slice(0, 10)
      : undefined,
    createdAt: Number(raw.createdAt) || Date.now(),
  }
}

export function normalizeInstallmentFile(raw: unknown): InstallmentFile {
  if (!isRecord(raw)) return createEmptyInstallmentFile()
  const list = Array.isArray(raw.plans) ? raw.plans : []
  const byId = new Map<string, InstallmentPlan>()
  for (const item of list) {
    const plan = normalizePlan(item)
    if (plan) byId.set(plan.id, plan)
  }
  return { version: 1, plans: [...byId.values()] }
}

export function loadInstallmentFile(): InstallmentFile {
  try {
    const raw = window.localStorage.getItem(INSTALLMENTS_STORAGE_KEY)
    if (!raw) return createEmptyInstallmentFile()
    return normalizeInstallmentFile(JSON.parse(raw))
  } catch {
    return createEmptyInstallmentFile()
  }
}

export function saveInstallmentFile(file: InstallmentFile): string | null {
  try {
    window.localStorage.setItem(INSTALLMENTS_STORAGE_KEY, JSON.stringify(file))
    return null
  } catch (e) {
    return e instanceof Error ? `定期划扣保存失败：${e.message}` : '定期划扣保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * 扣款（纯函数）
 * ------------------------------------------------------------------ */

export interface PayResult {
  portfolio: Portfolio
  plan: InstallmentPlan
  amount: number
  ok: boolean
  reason?: string
}

/** 从现金账户扣钱：允许扣成负数（信用卡等），不做余额校验 */
export function withdrawFromCashItem(
  portfolio: Portfolio,
  target: { categoryId: string; itemId: string },
  amount: number,
): { portfolio: Portfolio; ok: boolean; reason?: string } {
  if (!Number.isFinite(amount) || amount <= 0) return { portfolio, ok: false, reason: '金额无效' }
  const category = portfolio.categories.find((c) => c.id === target.categoryId)
  const item = category?.items.find((i) => i.id === target.itemId)
  if (!category || !item) return { portfolio, ok: false, reason: '找不到扣款账户，请重新选择' }
  if (item.kind !== 'amount') return { portfolio, ok: false, reason: '扣款账户必须是金额类条目' }
  return {
    portfolio: {
      ...portfolio,
      categories: portfolio.categories.map((c) =>
        c.id !== category.id
          ? c
          : {
              ...c,
              items: c.items.map((i) =>
                i.id === item.id && i.kind === 'amount'
                  ? { ...i, amount: roundMoney(safeNum(i.amount) - amount) }
                  : i,
              ),
            },
      ),
    },
    ok: true,
  }
}

/**
 * 扣一期：现金账户 −每期金额（可负）、负债金额 −实扣、剩余期数 −1、下次扣款日推进。
 * 最后一期按剩余金额兜差（除不尽时不会留下零头）。
 */
export function payInstallmentTerm(portfolio: Portfolio, plan: InstallmentPlan, payDate: string): PayResult {
  if (!isActive(plan)) return { portfolio, plan, amount: 0, ok: false, reason: '该计划已经结清' }

  const isLast = plan.remainingTerms === 1
  const amount = isLast ? roundMoney(plan.remainingAmount) : roundMoney(plan.perTermAmount)
  if (!(amount > 0)) return { portfolio, plan, amount: 0, ok: false, reason: '每期金额无效，请先修改计划' }

  const cash = withdrawFromCashItem(portfolio, plan.fromAccount, amount)
  if (!cash.ok) return { portfolio, plan, amount, ok: false, reason: cash.reason }

  const next: InstallmentPlan = {
    ...plan,
    remainingAmount: Math.max(0, roundMoney(plan.remainingAmount - amount)),
    remainingTerms: plan.remainingTerms - 1,
    nextDueDate: addMonths(plan.nextDueDate, INTERVAL_MONTHS[plan.interval]),
    paidTerms: plan.paidTerms + 1,
    paidTotal: roundMoney(plan.paidTotal + amount),
    lastPaidDate: payDate,
  }
  return { portfolio: cash.portfolio, plan: next, amount, ok: true }
}

/**
 * 把计划的口径同步到负债条目的余额上（条目余额 = 计划计入负债的金额）。
 * 计划存在时条目余额由计划维护，界面里不可手改 —— 要改就改计划。
 */
export function syncInstallmentAmounts(portfolio: Portfolio, plans: InstallmentPlan[]): Portfolio {
  if (plans.length === 0) return portfolio
  // 按「分类 → 计划」建索引：一个负债条目对应一个计划
  const byCategory = new Map<string, InstallmentPlan>()
  for (const plan of plans) byCategory.set(plan.categoryId, plan)
  let changed = false
  const categories = portfolio.categories.map((category) => {
    const plan = byCategory.get(category.id)
    if (!plan) return category
    const items = category.items.map((item) => {
      if (item.id !== plan.itemId || item.kind !== 'amount') return item
      const target = liabilityIncludedAmount(plan)
      if (Math.abs(safeNum(item.amount) - target) < 0.005) return item
      changed = true
      return { ...item, amount: target }
    })
    return { ...category, items }
  })
  return changed ? { ...portfolio, categories } : portfolio
}

/** 负债总额 = 手工负债条目 + 计划按开关计入的金额（进行中的计划） */
export function totalLiability(portfolio: Portfolio, plans: InstallmentPlan[]): number {
  const planByItem = new Set(plans.filter(isActive).map((p) => p.itemId))
  let sum = 0
  for (const category of portfolio.categories) {
    for (const item of category.items) {
      if (item.kind !== 'amount') continue
      // 有计划维护的条目已经由 sync 写入正确金额，避免重复计算
      if (planByItem.has(item.id)) continue
      if (category.isLiability) sum += Math.abs(safeNum(item.amount))
    }
  }
  for (const plan of plans) {
    if (!isActive(plan)) continue
    sum += liabilityIncludedAmount(plan)
  }
  return roundMoney(sum)
}
