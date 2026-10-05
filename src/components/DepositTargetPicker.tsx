import { useMemo } from 'react'
import type { Portfolio } from '../types/asset'
import { diagnoseDepositTargets, listDepositTargets, type DepositTargetDiagnosis, type FundingSource } from '../lib/settings'
import { formatCNY } from '../lib/format'

interface DepositTargetPickerProps {
  portfolio: Portfolio
  value?: FundingSource
  onChange: (source: FundingSource | undefined) => void
  testId: string
}

/**
 * 「写入哪个现金账户」选择框（薪资入账、分红入账共用）。
 *
 * 与「基金申购的资金来源」是两套规则：入账是**加钱**，
 * 所以余额 0 甚至负数的账户也必须能选；并且只列「现金与固定资产」这一个分类。
 */
export default function DepositTargetPicker({ portfolio, value, onChange, testId }: DepositTargetPickerProps) {
  const targets = useMemo(() => listDepositTargets(portfolio), [portfolio])
  const diagnosis = useMemo(() => diagnoseDepositTargets(portfolio), [portfolio])

  if (targets.length === 0) {
    return (
      <p
        className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink4"
        data-testid={`${testId}-empty`}
      >
        {explainEmpty(diagnosis)}
      </p>
    )
  }

  const missing = value !== undefined && !targets.some((t) => t.itemId === value.itemId)

  return (
    <div>
      <select
        data-testid={testId}
        value={value?.itemId ?? ''}
        onChange={(e) => {
          const hit = targets.find((t) => t.itemId === e.target.value)
          onChange(hit ? { categoryId: hit.categoryId, itemId: hit.itemId, itemName: hit.itemName } : undefined)
        }}
        className="field-input"
      >
        <option value="">请选择账户</option>
        {targets.map((t) => (
          <option key={t.itemId} value={t.itemId}>
            {t.itemName}（余额 {formatCNY(t.amount, 0)}）
          </option>
        ))}
      </select>
      {missing ? (
        <p className="mt-1.5 text-[11px] tone-warn">原来选的账户已经不在了，请重新选择</p>
      ) : null}
    </div>
  )
}

/** 空状态必须说清「为什么没有可选项」，否则用户不知道该去哪加 */
function explainEmpty(d: DepositTargetDiagnosis): string {
  if (!d.categoryFound) {
    return '没找到「现金与固定资产」这个分类（可能被删掉了）。请先在首页新建它，并在里面添加一个金额类条目（例如「招行活期」），之后就能选它入账。'
  }
  if (d.itemCount === 0) {
    return `「${d.categoryName}」目前是空的。请先在首页点进这个分类，添加一个金额类条目（例如「招行活期」），之后就能选它入账。`
  }
  if (d.amountItemCount === 0) {
    return `「${d.categoryName}」下有 ${d.itemCount} 个条目，但都不是金额类 —— 基金 / 黄金条目不能当现金账户。请添加一个金额类条目后再选。`
  }
  return '暂时没有可入账的账户。'
}
