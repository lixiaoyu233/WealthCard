import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Portfolio } from '../types/asset'
import type { FxRates } from '../lib/currency'
import {
  estimateAmountCny,
  holdingKey,
  type DividendMode,
  type DividendRecord,
} from '../lib/dividends'
import { fetchCloseOnDate } from '../lib/priceHistory'
import { HOLDING_MARKET_LABEL } from '../lib/usStock'
import type { FundingSource } from '../lib/settings'
import type { UseDividends } from '../hooks/useDividends'
import { formatCNY } from '../lib/format'

/** 一行的运行环境：设置页与首页卡片共用同一份，避免两处行为漂移 */
export interface DividendRowContext {
  portfolio: Portfolio
  dividends: UseDividends
  rates?: FxRates | null
  tax: { us: number; hk: number }
  defaultMode: DividendMode
  defaultCashTarget?: FundingSource
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
  /** 没有默认入账账户时的引导（设置页切到「分红设置」，首页卡片则打开设置） */
  onNeedCashAccount?: () => void
  /** 首页卡片不提供删除，避免误删 */
  hideDelete?: boolean
}

interface DividendEventRowProps {
  record: DividendRecord
  kind: 'confirmed' | 'estimated'
  basis?: string
  ctx: DividendRowContext
}

/**
 * 一笔分红：左侧日期/标的/金额，右侧按状态给操作。
 * 「预计」项只是预测，不给任何操作按钮。
 */
export default function DividendEventRow({ record: r, kind, basis, ctx }: DividendEventRowProps) {
  const [price, setPrice] = useState('')
  const [fetching, setFetching] = useState(false)

  const amount = estimateAmountCny(ctx.portfolio, r, ctx.tax, ctx.rates)
  const mode: DividendMode =
    r.mode ?? ctx.dividends.prefs[holdingKey(r.market, r.code)] ?? ctx.defaultMode

  const report = (outcome: { ok: boolean; reason?: string; message?: string }) =>
    ctx.notify(outcome.ok ? (outcome.message ?? '已处理') : (outcome.reason ?? '处理失败'), outcome.ok ? 'success' : 'error')

  const runCash = () => {
    if (!ctx.defaultCashTarget) {
      ctx.notify('请先选择默认入账账户', 'error')
      ctx.onNeedCashAccount?.()
      return
    }
    report(ctx.dividends.applyCash(r, ctx.defaultCashTarget))
  }

  const fillPrice = async () => {
    setFetching(true)
    try {
      const value = await fetchCloseOnDate(r.market, r.code, r.exDate)
      if (value === undefined) {
        ctx.notify(
          r.market === 'us' ? '美股历史价暂不支持自动获取，请手动填写' : '没取到该日期的历史价，请手动填写',
          'error',
        )
        return
      }
      setPrice(String(value))
    } catch {
      ctx.notify('取历史价失败，请手动填写', 'error')
    } finally {
      setFetching(false)
    }
  }

  return (
    <li className="rounded-xl border border-line bg-s2 px-3.5 py-2.5" data-testid={`dividend-row-${r.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] text-ink1">
            <span className="tabular-nums text-ink2">{r.exDate}</span>
            <span className="ml-2">{r.name || r.code}</span>
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink4">
            {HOLDING_MARKET_LABEL[r.market]} · 每份 {r.cashPerUnit} {r.currency}
            {r.afterTaxPerUnit !== undefined ? `（税后 ${r.afterTaxPerUnit}）` : ''}
            {r.bonusRatio ? ` · 10 送转 ${r.bonusRatio} 股` : ''}
          </p>
          {kind === 'estimated' && basis ? (
            <p className="mt-0.5 text-[11px] tone-info">预计依据：{basis}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[13px] font-medium tabular-nums text-ink1">≈ {formatCNY(amount, 2)}</p>
          <p className="mt-0.5 text-[11px] text-ink4">{mode === 'cash' ? '现金分红' : '再投资'}</p>
        </div>
      </div>

      {kind === 'confirmed' && !r.applied ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {mode === 'cash' ? (
            <button
              type="button"
              data-testid={`dividend-cash-${r.id}`}
              className="btn-ghost px-3 py-1.5 text-[12px]"
              onClick={runCash}
            >
              现金入账
            </button>
          ) : (
            <>
              <input
                data-testid={`dividend-price-${r.id}`}
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="除息日净值"
                className="field-input w-28 py-1.5 text-[12px] tabular-nums"
              />
              <button
                type="button"
                data-testid={`dividend-fetchprice-${r.id}`}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                disabled={fetching}
                onClick={() => void fillPrice()}
              >
                {fetching ? '取价中…' : '取除息日价'}
              </button>
              <button
                type="button"
                data-testid={`dividend-reinvest-${r.id}`}
                className="btn-ghost px-3 py-1.5 text-[12px]"
                onClick={() => report(ctx.dividends.applyReinvest(r, Number(price)))}
              >
                再投资
              </button>
            </>
          )}
          {r.bonusRatio ? (
            <button
              type="button"
              data-testid={`dividend-bonus-${r.id}`}
              className="btn-ghost px-3 py-1.5 text-[12px]"
              onClick={() => report(ctx.dividends.applyBonus(r))}
            >
              应用送转 10 送转 {r.bonusRatio} 股
            </button>
          ) : null}
          {r.source === 'manual' && !ctx.hideDelete ? (
            <button
              type="button"
              aria-label="删除该分红记录"
              className="ml-auto rounded-full p-1.5 text-ink4 transition hover:bg-danger/10 hover:tone-danger"
              onClick={() => ctx.dividends.remove(r.id)}
            >
              <Trash2 size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
      {r.applied ? <p className="mt-1.5 text-[11px] tone-down">✓ 已入账</p> : null}
    </li>
  )
}
