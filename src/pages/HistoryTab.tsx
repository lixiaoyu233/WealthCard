import { useState } from 'react'
import type { TrendSeries } from '../lib/performance/history'
import { ASSET_CLASS_LABEL } from '../lib/analysis/dimensions'

/**
 * 历史 Tab
 *
 * ## 数据来源
 *
 * 直接使用 Phase 4/7 保存的 `Snapshot`（经 `buildCompositionTrend`）。
 * **不重算、不插值、不补齐缺失日期**。
 *
 * ## captureKind 必须可见
 *
 * | 值 | UI 表现 |
 * | --- | --- |
 * | `REAL` | 正常显示「当日真实捕获」 |
 * | `BACKFILLED` / `ESTIMATED` | 明确标注来源 |
 * | `UNKNOWN` | 「历史快照 · 来源未标记」——**绝不当 REAL** |
 *
 * ## 历史分类不回填
 *
 * 快照缺 `assetClassAtCapture` 时，`hasClassification === false`，
 * UI 显示「历史分类数据不可用」，**不使用当前 Instrument 分类补历史**。
 */
export interface HistoryTabProps {
  trend: TrendSeries
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function HistoryTab({ trend }: HistoryTabProps) {
  const [showAll, setShowAll] = useState(false)

  if (trend.points.length === 0) {
    return (
      <div className="mx-auto w-full max-w-[480px] px-4 pt-4">
        <h1 className="text-[15px] font-medium text-ink">资产历史</h1>
        <div
          className="mt-4 rounded-2xl border border-line bg-s1 p-4 text-[12px] text-ink3"
          data-testid="history-empty"
        >
          <p className="font-medium text-ink2">还没有历史快照</p>
          <p className="mt-1.5 leading-relaxed text-ink4">
            配置趋势需要积累数据，从今天起每天会自动记录一次。
            <br />
            缺失的日期不会补数据，也不会用当前分类推测过去。
          </p>
        </div>
      </div>
    )
  }

  const points = showAll ? trend.points : [...trend.points].reverse().slice(0, 12)

  return (
    <div className="mx-auto w-full max-w-[480px] px-4">
      <header className="pt-4">
        <h1 className="text-[15px] font-medium text-ink">资产历史</h1>
        <p className="mt-1 text-[11px] text-ink4" data-testid="history-summary">
          {trend.summary}
        </p>
      </header>

      {/* 历史分类缺口：不伪造，明确告知 */}
      {trend.gaps.length > 0 ? (
        <section
          className="mt-3 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn"
          data-testid="history-gaps"
        >
          <p className="font-medium">部分历史快照缺少分类信息</p>
          <p className="mt-1 text-[11px] leading-relaxed">
            {trend.gaps.length} 个时点没有记录当时的资产分类，
            这些时点**不展示类别占比**（不使用今天的分类回填历史）。
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

      {/* 快照列表 */}
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
                  {!pt.isComplete ? <span className="ml-1.5 tone-warn">· 数据不完整</span> : null}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[13px] text-ink" data-testid="history-networth">
                  {cny(pt.netWorth)}
                </p>
                <p className="text-[10px] text-ink4">净资产</p>
              </div>
            </div>

            {/* 类别构成：仅在历史分类可用时展示 */}
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
              <p className="mt-2 border-t border-line pt-2 text-[11px] text-ink4" data-testid="class-unavailable">
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

      <p className="mt-3 px-1 pb-4 text-[11px] leading-relaxed text-ink4">
        只展示真实存在的快照，缺失日期不插值。
        来源未标记的历史快照不会被当作 REAL。
      </p>
    </div>
  )
}
