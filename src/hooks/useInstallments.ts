import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Portfolio } from '../types/asset'
import {
  type InstallmentFile,
  type InstallmentPlan,
  type PayResult,
  duePeriodCount,
  isActive,
  liabilityIncludedAmount,
  loadInstallmentFile,
  monthlyTotal,
  payInstallmentTerm,
  planForItem,
  removePlan,
  saveInstallmentFile,
  skipOverdueReminder,
  syncInstallmentAmounts,
  totalLiability,
  upsertPlan,
} from '../lib/installments'
import { todayKey } from '../lib/format'

export interface PlanOutcome {
  ok: boolean
  reason?: string
  message?: string
}

export interface UseInstallments {
  file: InstallmentFile
  plans: InstallmentPlan[]
  today: string
  planForItem: (itemId: string) => InstallmentPlan | undefined
  savePlan: (plan: InstallmentPlan) => void
  deletePlan: (planId: string) => void
  /** 确认扣一期：现金 −每期（可负）、欠款 −实扣、剩余期数 −1 */
  confirmTerm: (plan: InstallmentPlan) => PlanOutcome
  /** 忽略过期提醒：下次扣款日推到今天之后，期数/欠款不动 */
  skipReminder: (plan: InstallmentPlan) => void
  /** 已到期未处理的期数（只用于提示，不自动扣） */
  dueCount: (plan: InstallmentPlan) => number
  /** 负债总额（含分期，按各计划的开关口径） */
  totalLiabilityCny: number
  /** 每月还款合计（每季 ÷3、每年 ÷12） */
  monthlyCny: number
}

/**
 * 定期划扣：计划状态 + 持久化 + 把计划金额同步到负债条目 + 确认扣款。
 *
 * 口径（与用户确认）：不自动扣，只在界面提示；漏掉的期次不追扣，可忽略提醒；
 * 允许把现金账户扣成负数；计划存在时条目余额由计划维护。
 */
export function useInstallments(
  portfolio: Portfolio,
  applyPortfolio: (p: Portfolio) => void,
): UseInstallments {
  const [file, setFile] = useState<InstallmentFile>(() => loadInstallmentFile())
  const today = todayKey()

  useEffect(() => {
    saveInstallmentFile(file)
  }, [file])

  /** 计划金额 → 负债条目余额（有计划维护的条目在界面里不可手改） */
  useEffect(() => {
    if (file.plans.length === 0) return
    const synced = syncInstallmentAmounts(portfolio, file.plans)
    if (synced !== portfolio) applyPortfolio(synced)
  }, [portfolio, file.plans, applyPortfolio])

  const savePlan = useCallback((plan: InstallmentPlan) => {
    setFile((prev) => upsertPlan(prev, plan))
  }, [])

  const deletePlan = useCallback((planId: string) => {
    setFile((prev) => removePlan(prev, planId))
  }, [])

  const confirmTerm = useCallback(
    (plan: InstallmentPlan): PlanOutcome => {
      const result: PayResult = payInstallmentTerm(portfolio, plan, today)
      if (!result.ok) return { ok: false, reason: result.reason }
      applyPortfolio(result.portfolio)
      setFile((prev) => upsertPlan(prev, result.plan))
      return {
        ok: true,
        message:
          result.plan.remainingTerms > 0
            ? `已扣 ${result.amount} 元，还剩 ${result.plan.remainingTerms} 期`
            : `已扣 ${result.amount} 元，该计划已结清`,
      }
    },
    [portfolio, today, applyPortfolio],
  )

  const skipReminder = useCallback(
    (plan: InstallmentPlan) => {
      setFile((prev) => upsertPlan(prev, skipOverdueReminder(plan, today)))
    },
    [today],
  )

  const dueCount = useCallback((plan: InstallmentPlan) => duePeriodCount(plan, today), [today])

  const totalLiabilityCny = useMemo(
    () => totalLiability(portfolio, file.plans),
    [portfolio, file.plans],
  )
  const monthlyCny = useMemo(() => monthlyTotal(file.plans), [file.plans])

  const findPlan = useCallback((itemId: string) => planForItem(file.plans, itemId), [file.plans])

  return {
    file,
    plans: file.plans,
    today,
    planForItem: findPlan,
    savePlan,
    deletePlan,
    confirmTerm,
    skipReminder,
    dueCount,
    totalLiabilityCny,
    monthlyCny,
  }
}

/** 计划是否还在进行中（组件里用） */
export const isActivePlan = isActive
/** 计划计入负债的金额（组件里用） */
export const planLiability = liabilityIncludedAmount
