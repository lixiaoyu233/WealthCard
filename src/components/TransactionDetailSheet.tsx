import { useMemo } from 'react'
import type { Account, Instrument, Portfolio2, Transaction } from '../types/portfolio2'
import { TRANSACTION_TYPE_LABEL } from '../types/portfolio2'
import { hasExternalFlow } from '../lib/ledger/externalFlow'
import Sheet from './Sheet'

/**
 * 交易详情 Sheet（Phase 8 / W4）
 *
 * ## 展示的是**真实派生关系**，不是另算一套
 *
 * 「这笔交易产生了什么效果」直接展示 `deriveLedger` 产出的
 * Ledger Effects（投资腿 / 现金腿 / 收入 / 已实现盈亏 / 费用），
 * 而不是在 UI 里重新推导一遍。
 *
 * ## 外部现金流归属
 *
 * 明确标注该交易是否属于外部流入 / 流出 —— 这是 Phase 4 的语义，
 * 关系到期初/期末净资产的归因，用户需要能看懂。
 */
export interface TransactionDetailSheetProps {
  transaction: Transaction
  portfolio: Portfolio2
  accountById: Map<string, Account>
  instrumentById: Map<string, Instrument>
  /** 该交易对应的 Ledger Effects（由调用方从 deriveLedger 取出） */
  effects: Array<{
    leg: 'instrument' | 'cash' | 'cash_target'
    instrumentId: string
    accountId: string
    quantityDelta: number
    costDelta: number
    cashDelta: number
    incomeDelta?: number
    feeDelta?: number
  }>
  onClose: () => void
}

const n = (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 8 })
const signed = (v: number) => (v > 0 ? `+${n(v)}` : n(v))

export default function TransactionDetailSheet({
  transaction: tx,
  accountById,
  instrumentById,
  effects,
  onClose,
}: TransactionDetailSheetProps) {
  const external = useMemo(() => hasExternalFlow(tx.type), [tx.type])

  const rows: Array<[string, string]> = [
    ['交易类型', TRANSACTION_TYPE_LABEL[tx.type] ?? tx.type],
    ['日期', new Date(tx.timestamp).toLocaleString('zh-CN')],
    ['账户', accountById.get(tx.accountId)?.name ?? tx.accountId],
  ]
  if (tx.toAccountId) rows.push(['目标账户', accountById.get(tx.toAccountId)?.name ?? tx.toAccountId])
  if (tx.instrumentId) rows.push(['标的', instrumentById.get(tx.instrumentId)?.name ?? tx.instrumentId])
  if (tx.cashInstrumentId) {
    rows.push(['资金账户', instrumentById.get(tx.cashInstrumentId)?.name ?? tx.cashInstrumentId])
  }
  if (tx.toCashInstrumentId) {
    rows.push(['换入账户', instrumentById.get(tx.toCashInstrumentId)?.name ?? tx.toCashInstrumentId])
  }
  if (tx.quantity !== undefined) rows.push(['数量', n(tx.quantity)])
  if (tx.transferQuantity !== undefined) rows.push(['划转数量', n(tx.transferQuantity)])
  rows.push(['金额', `${n(tx.amount)} ${tx.currency}`])
  if (tx.toAmount !== undefined) {
    rows.push(['到账金额', `${n(tx.toAmount)} ${tx.toCurrency ?? tx.currency}`])
  }
  if (tx.fee) rows.push(['手续费', n(tx.fee)])
  if (tx.note) rows.push(['备注', tx.note])

  return (
    <Sheet
      open
      onClose={onClose}
      title="交易详情"
      subtitle={TRANSACTION_TYPE_LABEL[tx.type] ?? tx.type}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-xl border border-line bg-s1 py-2.5 text-[13px] text-ink2"
          data-testid="tx-detail-close"
        >
          关闭
        </button>
      }
    >
      <dl className="space-y-1.5 text-[12px]" data-testid="tx-detail-fields">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="shrink-0 text-ink3">{k}</dt>
            <dd className="min-w-0 break-all text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>

      {/* 外部现金流归属：Phase 4 语义 */}
      <p
        className="mt-3 rounded-xl border border-line bg-s2 px-3 py-2 text-[11px] leading-relaxed text-ink3"
        data-testid="tx-detail-flow"
      >
        外部现金流：
        <span className={external ? 'text-ink' : 'text-ink3'}>
          {external
            ? tx.type === 'deposit'
              ? '属于外部流入'
              : '属于外部流出'
            : '不属于（不影响净资产的外部增减）'}
        </span>
      </p>

      {/* Ledger Effects：真实派生结果 */}
      <h3 className="mt-4 text-[12px] font-medium text-ink2">账本效果（Ledger Effects）</h3>
      {effects.length === 0 ? (
        <p className="mt-1 text-[11px] text-ink4" data-testid="tx-detail-no-effects">
          该交易没有产生持仓效果（或仅记录流水）。
        </p>
      ) : (
        <ul className="mt-1.5 space-y-1.5" data-testid="tx-detail-effects">
          {effects.map((e, i) => {
            const inst = instrumentById.get(e.instrumentId)
            const legLabel =
              e.leg === 'instrument' ? '投资腿' : e.leg === 'cash' ? '资金腿（转出）' : '资金腿（转入）'
            return (
              <li
                key={`${e.instrumentId}-${e.leg}-${i}`}
                className="rounded-xl border border-line bg-s1 px-3 py-2 text-[11px]"
              >
                <p className="text-ink2">
                  {legLabel} · {inst?.name ?? e.instrumentId}
                </p>
                <p className="mt-0.5 text-ink3">
                  数量 {signed(e.quantityDelta)}
                  {e.costDelta !== 0 ? ` · 成本 ${signed(e.costDelta)}` : ''}
                  {e.cashDelta !== 0 ? ` · 现金 ${signed(e.cashDelta)}` : ''}
                  {e.incomeDelta ? ` · 收入 ${signed(e.incomeDelta)}` : ''}
                  {e.feeDelta ? ` · 费用 ${signed(e.feeDelta)}` : ''}
                </p>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
