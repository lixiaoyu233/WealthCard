import { useMemo, useState } from 'react'
import type { Portfolio2, Transaction, TransactionType } from '../types/portfolio2'
import type { TrendSeries } from '../lib/performance/history'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'
import { queryTransactions, type TransactionQuery } from '../lib/ledger/transactionService'
import { deriveLedger } from '../lib/ledger/derive'
import FlowsView from '../components/FlowsView'
import TransactionDetailSheet from '../components/TransactionDetailSheet'

/**
 * 历史 Tab（Phase 8 / W4 扩展）
 *
 * ## 二级视图
 *
 * | 视图 | 数据来源 |
 * | --- | --- |
 * | **交易流水** | `Transaction`（事实源）+ Ledger Effects 详情 |
 * | **资产快照** | `Snapshot`（Phase 4/7），含 captureKind 与历史分类缺口 |
 *
 * 按用户要求**不新增第六个底部 Tab**，流水放在这里作为二级视图。
 *
 * ## 保持的语义
 *
 * - `captureKind` 缺失 → UNKNOWN，绝不当 REAL
 * - 历史 `assetClassAtCapture` 缺失 → 显示「历史分类数据不可用」，不用当前分类回填
 * - 不插值、不补缺失日期
 */
export interface HistoryTabProps {
  trend: TrendSeries
  portfolio: Portfolio2
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function HistoryTab({ trend, portfolio }: HistoryTabProps) {
  const [view, setView] = useState<'flows' | 'snapshots'>('flows')
  const [showAll, setShowAll] = useState(false)
  const [accountFilter, setAccountFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selected, setSelected] = useState<Transaction | null>(null)

  const accountById = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a])),
    [portfolio.accounts],
  )
  const instrumentById = useMemo(
    () => new Map(portfolio.instruments.map((i) => [i.id, i])),
    [portfolio.instruments],
  )

  /** 筛选后的交易（只筛选，不重算金额） */
  const flows = useMemo(() => {
    const query: TransactionQuery = {}
    if (accountFilter) query.accountId = accountFilter
    if (typeFilter) query.type = typeFilter as TransactionType
    return queryTransactions(portfolio.transactions, query)
  }, [portfolio.transactions, accountFilter, typeFilter])

  /** 每笔交易的 Ledger Effects（真实派生关系，供详情展示） */
  const entriesByTx = useMemo(() => {
    const ledger = deriveLedger(portfolio.transactions, {
      instrumentCurrency: (id) => portfolio.instruments.find((i) => i.id === id)?.currency,
    })
    const m = new Map<string, typeof ledger.entries>()
    for (const e of ledger.entries) {
      const list = m.get(e.transactionId) ?? []
      list.push(e)
      m.set(e.transactionId, list)
    }
    return m
  }, [portfolio.transactions, portfolio.instruments])

  const points = showAll ? trend.points : [...trend.points].reverse().slice(0, 12)

  return (
    <div className="mx-auto w-full max-w-[480px] px-4">
      <header className="pt-4">
        <h1 className="text-[15px] font-medium text-ink">资产历史</h1>
        <p className="mt-1 text-[11px] text-ink4">
          {portfolio.transactions.length} 笔交易 · {trend.points.length} 个快照
        </p>
      </header>

      {/* 二级视图切换 */}
      <div className="mt-3 flex gap-1.5" data-testid="history-view-tabs">
        <button
          type="button"
          onClick={() => setView('flows')}
          className={`rounded-full border px-3 py-1 text-[12px] ${
            view === 'flows' ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
          }`}
          data-testid="view-flows"
        >
          交易流水
        </button>
        <button
          type="button"
          onClick={() => setView('snapshots')}
          className={`rounded-full border px-3 py-1 text-[12px] ${
            view === 'snapshots' ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
          }`}
          data-testid="view-snapshots"
        >
          资产快照
        </button>
      </div>

      {view === 'flows' ? (
        <FlowsView
          flows={flows}
          accounts={portfolio.accounts}
          accountById={accountById}
          instrumentById={instrumentById}
          accountFilter={accountFilter}
          typeFilter={typeFilter}
          onAccountFilter={setAccountFilter}
          onTypeFilter={setTypeFilter}
          onSelect={setSelected}
        />
      ) : (
        <>
          <p className="mt-3 text-[11px] text-ink4" data-testid="history-summary">
            {trend.summary}
          </p>

          {trend.points.length === 0 ? (
            <div
              className="mt-3 rounded-2xl border border-line bg-s1 p-4 text-[12px] text-ink3"
              data-testid="history-empty"
            >
              <p className="font-medium text-ink2">还没有历史快照</p>
              <p className="mt-1.5 leading-relaxed text-ink4">
                配置趋势需要积累数据，从今天起每天会自动记录一次。
                <br />
                缺失的日期不会补数据，也不会用当前分类推测过去。
              </p>
            </div>
          ) : (
            <>
              {trend.gaps.length > 0 ? (
                <section
                  className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
                  data-testid="history-gaps"
                >
                  <p className="font-medium">部分历史快照缺少分类信息</p>
                  <p className="mt-1 text-[11px] leading-relaxed">
                    {trend.gaps.length} 个时点没有记录当时的资产分类，这些时点不展示类别占比
                    （不使用今天的分类回填历史）。
                  </p>
                  <ul className="mt-1 space-y-0.5 text-[11px] text-ink4">
                    {trend.gaps.slice(0, 5).map((g) => (
                      <li key={g.date}>
                        · {g.date}：{g.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <ul className="mt-3 space-y-2" data-testid="history-list">
                {points.map((pt) => (
                  <li
                    key={pt.date}
                    className="rounded-2xl border border-line bg-s1 p-3"
                    data-testid="history-point"
                    data-date={pt.date}
                    data-capture-kind={pt.captureKind}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink">{pt.date}</p>
                        <p className="mt-0.5 text-[11px]" data-testid="capture-kind">
                          <span
                            className={
                              pt.captureKind === 'REAL'
                                ? 'text-ink4'
                                : pt.captureKind === 'UNKNOWN'
                                  ? 'tone-warn'
                                  : 'text-ink3'
                            }
                          >
                            {pt.captureKindLabel}
                          </span>
                          {!pt.isComplete ? (
                            <span className="ml-1.5 tone-warn">· 数据不完整</span>
                          ) : null}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[13px] text-ink" data-testid="history-networth">
                          {cny(pt.netWorth)}
                        </p>
                        <p className="text-[10px] text-ink4">净资产</p>
                      </div>
                    </div>

                    {pt.hasClassification && pt.byClass ? (
                      <ul className="mt-2 space-y-0.5 border-t border-line pt-2 text-[11px]">
                        {Object.entries(pt.byClass)
                          .sort((a, b) => b[1] - a[1])
                          .map(([cls, v]) => (
                            <li key={cls} className="flex justify-between">
                              <span className="text-ink3">
                                {ASSET_CLASS_LABEL[cls as keyof typeof ASSET_CLASS_LABEL] ?? cls}
                              </span>
                              <span className="text-ink2">
                                {cny(v)}
                                <span className="ml-1.5 text-ink4">
                                  {pt.byClassShare?.[cls] !== undefined
                                    ? `${((pt.byClassShare[cls] ?? 0) * 100).toFixed(0)}%`
                                    : ''}
                                </span>
                              </span>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p
                        className="mt-2 border-t border-line pt-2 text-[11px] text-ink4"
                        data-testid="class-unavailable"
                      >
                        历史分类数据不可用（当时未记录分类）
                      </p>
                    )}
                  </li>
                ))}
              </ul>

              {trend.points.length > 12 ? (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-3 w-full rounded-xl border border-line bg-s1 py-2 text-[12px] text-ink2"
                >
                  {showAll ? '收起' : `显示全部 ${trend.points.length} 个时点`}
                </button>
              ) : null}
            </>
          )}

          <p className="mt-3 px-1 pb-4 text-[11px] leading-relaxed text-ink4">
            只展示真实存在的快照，缺失日期不插值。
            来源未标记的历史快照不会被当作 REAL。
          </p>
        </>
      )}

      {selected ? (
        <TransactionDetailSheet
          transaction={selected}
          portfolio={portfolio}
          accountById={accountById}
          instrumentById={instrumentById}
          effects={entriesByTx.get(selected.id) ?? []}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}
