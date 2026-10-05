import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { CurrencyCode } from '../lib/currency'
import { FREQUENCY_LABEL, type DividendFrequency, type DividendMode, type DividendRecord } from '../lib/dividends'
import { estimateUpcoming } from '../lib/dividendCalendar'
import { HOLDING_MARKET_LABEL, type HoldingMarket } from '../lib/usStock'
import { todayKey } from '../lib/format'

export interface DividendFormTarget {
  code: string
  market: HoldingMarket
  name?: string
  itemId?: string
  currency: CurrencyCode
}

interface DividendFormProps {
  target: DividendFormTarget
  /** 该标的历史记录，用于「按历史推定」预填 */
  history?: DividendRecord[]
  onSubmit: (record: DividendRecord) => void
  onCancel: () => void
}

const FREQS: DividendFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual', 'irregular']

/** 手工录入一笔分红（自动源覆盖不到的基金 / 港股 / 美股走这里） */
export default function DividendForm({ target, history = [], onSubmit, onCancel }: DividendFormProps) {
  const [exDate, setExDate] = useState('')
  const [frequency, setFrequency] = useState<DividendFrequency>('annual')
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<DividendMode>('cash')
  const [payDate, setPayDate] = useState('')
  const [bonus, setBonus] = useState('')
  const [error, setError] = useState<string | null>(null)

  /** 按历史/周期推算下一次，减少手填 */
  const suggest = () => {
    if (history.length === 0) return
    const [estimate] = estimateUpcoming(history, todayKey())
    if (estimate) {
      setExDate(estimate.nextDate)
      setAmount(String(estimate.cashPerUnit))
      setFrequency(history[history.length - 1].frequency)
      return
    }
    // 没有可推算的下一次，就用最近一笔的频率与金额
    const sorted = [...history].sort((a, b) => a.exDate.localeCompare(b.exDate))
    const last = sorted[sorted.length - 1]
    setFrequency(last.frequency)
    setAmount(String(last.cashPerUnit))
  }

  const submit = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exDate)) return setError('请选择分红日期（除息日）')
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) return setError('每份分红金额必须大于 0')
    const ratio = bonus.trim() === '' ? undefined : Number(bonus)
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0)) return setError('送转比例必须大于 0（每 10 股）')

    onSubmit({
      // 同一标的 + 同一天重复录入会覆盖，避免重复记账
      id: `manual_${target.market}:${target.code.toUpperCase()}_${exDate}`,
      code: target.code.toUpperCase(),
      market: target.market,
      name: target.name,
      itemId: target.itemId,
      exDate,
      payDate: payDate || undefined,
      cashPerUnit: value,
      bonusRatio: ratio,
      currency: target.currency,
      frequency,
      mode,
      source: 'manual',
    })
  }

  return (
    <div className="rounded-xl border border-line bg-s2 px-3.5 py-3" data-testid="dividend-form">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-medium text-ink1">
          {target.name || target.code}
          <span className="ml-1.5 text-[11px] font-normal text-ink4">
            {HOLDING_MARKET_LABEL[target.market]} · {target.code}
          </span>
        </p>
        {history.length > 0 ? (
          <button
            type="button"
            data-testid="dividend-suggest"
            onClick={suggest}
            className="inline-flex items-center gap-1 text-[11.5px] text-ink3 underline-offset-2 hover:underline"
          >
            <Sparkles size={12} /> 按历史推定
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="field-label">分红日期（除息日）</span>
          <input
            type="date"
            data-testid="dividend-exdate"
            value={exDate}
            onChange={(e) => setExDate(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="field-label">分红周期</span>
          <select
            data-testid="dividend-frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as DividendFrequency)}
            className="field-input"
          >
            {FREQS.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">每份 / 每股分红（{target.currency}，税前）</span>
          <input
            data-testid="dividend-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            placeholder="如 0.15"
            className="field-input tabular-nums"
          />
        </label>
        <label className="block">
          <span className="field-label">分红方式</span>
          <select
            data-testid="dividend-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as DividendMode)}
            className="field-input"
          >
            <option value="cash">现金分红</option>
            <option value="reinvest">分红再投资</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label">派息日（可选）</span>
          <input
            type="date"
            data-testid="dividend-paydate"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            className="field-input"
          />
        </label>
        <label className="block">
          <span className="field-label">送转比例（可选，每 10 股）</span>
          <input
            data-testid="dividend-bonus"
            value={bonus}
            onChange={(e) => setBonus(e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            placeholder="如 4"
            className="field-input tabular-nums"
          />
        </label>
      </div>

      {error ? (
        <p className="mt-2 text-[11.5px] tone-warn" data-testid="dividend-form-error">
          {error}
        </p>
      ) : null}

      <div className="mt-2.5 flex gap-2">
        <button type="button" data-testid="dividend-save" className="btn-primary flex-1" onClick={submit}>
          保存
        </button>
        <button type="button" className="btn-ghost px-4" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
