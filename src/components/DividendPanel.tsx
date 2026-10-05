import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { Portfolio } from '../types/asset'
import type { FxRates } from '../lib/currency'
import { estimateAmountCny, holdingKey, type DividendMode } from '../lib/dividends'
import { buildMonthView, buildPeriodSummary, type DividendPeriod } from '../lib/dividendCalendar'
import { HOLDING_MARKET_CURRENCY, HOLDING_MARKET_LABEL, type HoldingMarket } from '../lib/usStock'
import type { DividendSettings } from '../lib/settings'
import type { UseDividends } from '../hooks/useDividends'
import DividendEventRow, { type DividendRowContext } from './DividendEventRow'
import { formatCNY, todayKey } from '../lib/format'
import DepositTargetPicker from './DepositTargetPicker'
import DividendForm, { type DividendFormTarget } from './DividendForm'

type Tab = 'calendar' | 'pending' | 'settings'

const TAB_LABEL: Record<Tab, string> = {
  calendar: '日历',
  pending: '待补录',
  settings: '分红设置',
}

interface DividendPanelProps {
  portfolio: Portfolio
  dividends: UseDividends
  rates?: FxRates | null
  dividendSettings: DividendSettings
  onSetDividendSettings: (patch: Partial<DividendSettings>) => void
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
}

/** 百分比输入 ↔ 0~1 税率 */
const toPercent = (rate: number) => String(Math.round(rate * 1000) / 10)
const toRate = (value: string) => {
  const n = Number(value.replace(/[^\d.]/g, ''))
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 10) / 1000 : 0
}

export default function DividendPanel({
  portfolio,
  dividends,
  rates,
  dividendSettings,
  onSetDividendSettings,
  notify,
}: DividendPanelProps) {
  const [tab, setTab] = useState<Tab>('calendar')
  const [period, setPeriod] = useState<DividendPeriod>('year')
  const [formTarget, setFormTarget] = useState<DividendFormTarget | null>(null)

  const today = todayKey()
  const tax = { us: dividendSettings.usTaxRate, hk: dividendSettings.hkTaxRate }

  const view = useMemo(() => buildMonthView(dividends.records, today.slice(0, 7), today), [dividends.records, today])
  const produced = useMemo(
    () => buildPeriodSummary(dividends.records, period, today),
    [dividends.records, period, today],
  )
  const producedTotal = produced.reduce((sum, r) => sum + estimateAmountCny(portfolio, r, tax, rates), 0)

  /** 持仓里「还没有任何分红信息」的标的（黄金与纯金额条目没有份额概念，不列） */
  const pending = useMemo(() => {
    const withRecords = new Set(dividends.records.map((r) => holdingKey(r.market, r.code)))
    const seen = new Set<string>()
    const out: DividendFormTarget[] = []
    for (const category of portfolio.categories) {
      for (const item of category.items) {
        if (item.kind !== 'fund') continue
        const code = (item.code ?? '').trim()
        if (!code) continue
        const market: HoldingMarket = item.market ?? 'cn'
        const key = holdingKey(market, code)
        if (withRecords.has(key) || seen.has(key)) continue
        seen.add(key)
        out.push({ code, market, name: item.name, itemId: item.id, currency: HOLDING_MARKET_CURRENCY[market] })
      }
    }
    return out
  }, [portfolio, dividends.records])

  /** 行组件的运行环境：设置页与首页卡片共用同一个组件，避免两处行为漂移 */
  const rowCtx: DividendRowContext = {
    portfolio,
    dividends,
    rates,
    tax,
    defaultMode: dividendSettings.defaultMode,
    defaultCashTarget: dividendSettings.defaultCashTarget,
    notify,
    onNeedCashAccount: () => setTab('settings'),
  }


  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-s2 p-1">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            data-testid={`dividend-tab-${key}`}
            onClick={() => setTab(key)}
            className={`rounded-lg py-2 text-[13px] transition ${
              tab === key ? 'bg-invert text-on-invert' : 'text-ink3 hover:text-ink2'
            }`}
          >
            {TAB_LABEL[key]}
            {key === 'pending' && pending.length > 0 ? (
              <span className="ml-1 text-[11px] opacity-80">{pending.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'calendar' ? (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <p className="field-label mb-0">本月 {today.slice(0, 7)}</p>
            <button
              type="button"
              data-testid="dividend-refresh"
              onClick={() => void dividends.refresh()}
              disabled={dividends.loading}
              className="inline-flex items-center gap-1 text-[11.5px] text-ink3 underline-offset-2 hover:underline disabled:opacity-50"
            >
              <RefreshCw size={12} className={dividends.loading ? 'animate-spin' : ''} />
              {dividends.loading ? '抓取中…' : `刷新 A股分红（${dividends.ashareCodes.length}）`}
            </button>
          </div>
          {dividends.error ? <p className="text-[11.5px] tone-warn">分红抓取失败：{dividends.error}</p> : null}

          <div>
            <p className="mb-1.5 text-[11.5px] text-ink4">已确认（{view.confirmed.length}）</p>
            {view.confirmed.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] text-ink4">
                本月没有已公告的分红。
              </p>
            ) : (
              <ul className="space-y-2">
                {view.confirmed.map((e) => (
                  <DividendEventRow key={e.record.id} record={e.record} kind="confirmed" basis={e.basis} ctx={rowCtx} />
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-1.5 text-[11.5px] text-ink4">按历史推算（{view.estimated.length}）</p>
            {view.estimated.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] text-ink4">
                没有可推算的分红（需要至少 2 年同月记录，或你指定的分红周期）。
              </p>
            ) : (
              <ul className="space-y-2">
                {view.estimated.map((e) => (
                  <DividendEventRow key={e.record.id} record={e.record} kind="estimated" basis={e.basis} ctx={rowCtx} />
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-line pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="field-label mb-0">已产生的分红</p>
              <div className="flex gap-1">
                {(['month', 'quarter', 'year'] as DividendPeriod[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`dividend-period-${key}`}
                    onClick={() => setPeriod(key)}
                    className={`rounded-lg border px-2 py-1 text-[12px] transition ${
                      period === key ? 'border-line-strong bg-s3 text-ink1' : 'border-line bg-s2 text-ink4 hover:bg-s3'
                    }`}
                  >
                    {key === 'month' ? '本月' : key === 'quarter' ? '本季' : '今年'}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[13px] text-ink1" data-testid="dividend-produced-total">
              合计 <span className="font-medium tabular-nums">{formatCNY(producedTotal, 2)}</span> 元 · {produced.length} 笔
            </p>
            {produced.length > 0 ? (
              <ul className="mt-2 space-y-2">
                {produced.map((r) => (
                  <DividendEventRow key={r.id} record={r} kind="confirmed" ctx={rowCtx} />
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === 'pending' ? (
        <div className="space-y-3">
          <p className="text-[11.5px] leading-relaxed text-ink4">
            下面是还没有分红信息的标的。A股会自动抓取（抓不到说明该股暂无已实施的分红）；基金 / 港股 / 美股需要手工录入。
          </p>

          {formTarget ? (
            <DividendForm
              target={formTarget}
              history={dividends.records.filter(
                (r) => holdingKey(r.market, r.code) === holdingKey(formTarget.market, formTarget.code),
              )}
              onSubmit={(record) => {
                dividends.addManual(record)
                setFormTarget(null)
                notify('已保存分红记录', 'success')
              }}
              onCancel={() => setFormTarget(null)}
            />
          ) : null}

          {pending.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] text-ink4">
              所有持仓都已经有分红记录了。
            </p>
          ) : (
            <ul className="space-y-2">
              {pending.map((t) => (
                <li
                  key={holdingKey(t.market, t.code)}
                  className="flex items-center gap-2 rounded-xl border border-line bg-s2 px-3.5 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink1">{t.name || t.code}</span>
                    <span className="mt-0.5 block text-[11px] text-ink4">
                      {HOLDING_MARKET_LABEL[t.market]} · {t.code} ·{' '}
                      {t.market === 'ashare' ? '自动源未命中' : '暂无自动源，需手工录入'}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid={`dividend-entry-${t.code}`}
                    className="btn-ghost shrink-0 px-3 py-1.5 text-[12px]"
                    onClick={() => setFormTarget(t)}
                  >
                    录入
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {tab === 'settings' ? (
        <div className="space-y-5">
          <div>
            <p className="field-label">现金分红默认入账账户</p>
            <DepositTargetPicker
              testId="dividend-cash-target"
              portfolio={portfolio}
              value={dividendSettings.defaultCashTarget}
              onChange={(source) => onSetDividendSettings({ defaultCashTarget: source })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="field-label">美股预扣税率（%）</span>
              <input
                data-testid="dividend-tax-us"
                value={toPercent(dividendSettings.usTaxRate)}
                onChange={(e) => onSetDividendSettings({ usTaxRate: toRate(e.target.value) })}
                inputMode="decimal"
                className="field-input tabular-nums"
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-ink4">
                中国居民常见 10%（递交 W-8BEN）或 30%
              </span>
            </label>
            <label className="block">
              <span className="field-label">港股预扣税率（%）</span>
              <input
                data-testid="dividend-tax-hk"
                value={toPercent(dividendSettings.hkTaxRate)}
                onChange={(e) => onSetDividendSettings({ hkTaxRate: toRate(e.target.value) })}
                inputMode="decimal"
                className="field-input tabular-nums"
              />
              <span className="mt-1 block text-[11px] leading-relaxed text-ink4">H 股常见 10%，部分港股为 0</span>
            </label>
          </div>

          <label className="block">
            <span className="field-label">新标的默认分红方式</span>
            <select
              data-testid="dividend-default-mode"
              value={dividendSettings.defaultMode}
              onChange={(e) => onSetDividendSettings({ defaultMode: e.target.value as DividendMode })}
              className="field-input"
            >
              <option value="cash">现金分红</option>
              <option value="reinvest">分红再投资</option>
            </select>
          </label>

          <p className="text-[11px] leading-relaxed text-ink4">
            A股分红自动抓取（东财公开接口，含未来已公告的除权除息日）：当前 {dividends.ashareCodes.length} 只
            A股持仓。A股按公告的税后金额入账；美股 / 港股按上面填写的税率扣税。
          </p>
        </div>
      ) : null}
    </div>
  )
}
