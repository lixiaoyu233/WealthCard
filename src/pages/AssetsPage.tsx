import { useMemo, useState } from 'react'
import type { Portfolio2 } from '../types/portfolio2'
import type { AnalysisView } from '../lib/analysis'
import type { ValuationResult } from '../lib/valuation/types'
import {
  ACCOUNT_TYPE_LABEL,
  ASSET_CLASS_LABEL,
  INSTRUMENT_TYPE_LABEL,
  REGION_LABEL,
} from '../lib/analysis/dimensions'

/**
 * W2 资产管理只读视图
 *
 * ## 数据来源
 *
 * 全部来自 `Repository → Holdings → Valuation → Analysis`。
 * **绝不**从 localStorage legacy 数据重新计算。
 *
 * ## 组件职责
 *
 * 只做：展示、切维度、排序、下钻。
 * **不做任何金融计算** —— 金额与可用性判断都取自传入的派生结果。
 */
export type AssetDimension =
  | 'holdings'
  | 'accounts'
  | 'currency'
  | 'assetClass'
  | 'region'
  | 'instrumentType'

export interface AssetsPageProps {
  portfolio: Portfolio2
  analysis: AnalysisView
  results: ValuationResult[]
  region?: string
  onRegionChange?: (next: string) => void
}

const cny = (n: number) =>
  `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const DIMENSION_LABEL: Record<AssetDimension, string> = {
  holdings: '持仓',
  accounts: '账户',
  currency: '币种',
  assetClass: '资产类别',
  region: '地区',
  instrumentType: '工具类型',
}

/** 估值状态徽章 —— stale 与 unavailable 必须与 ok 视觉可分 */
function StatusBadge({ result }: { result: ValuationResult | undefined }) {
  if (!result) return <span className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink4">无估值</span>
  if (result.status === 'ok') {
    return <span className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink2">可靠</span>
  }
  if (result.status === 'stale') {
    return (
      <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[10px] tone-warn" title="有旧值但不代表当前可靠值">
        估值已过期
      </span>
    )
  }
  return (
    <span
      className="rounded bg-s2 px-1.5 py-0.5 text-[10px] text-ink4"
      title={result.reasons.join('、') || '无法可靠估值'}
    >
      无法估值
    </span>
  )
}

export default function AssetsPage({
  portfolio,
  analysis,
  results,
  region,
  onRegionChange,
}: AssetsPageProps) {
  const [dimension, setDimension] = useState<AssetDimension>('holdings')

  const resultByHolding = useMemo(
    () => new Map(results.map((r) => [r.holdingId, r])),
    [results],
  )
  const instrumentById = useMemo(
    () => new Map(portfolio.instruments.map((i) => [i.id, i])),
    [portfolio.instruments],
  )
  const accountById = useMemo(
    () => new Map(portfolio.accounts.map((a) => [a.id, a])),
    [portfolio.accounts],
  )

  /** 当前维度下的分组（只做分组，不做金额重算 —— 金额取自 AnalysisView） */
  const buckets = useMemo(() => {
    switch (dimension) {
      case 'assetClass':
        return analysis.byAssetClass
      case 'accounts':
        return analysis.byAccount
      case 'currency':
        return analysis.byCurrency
      case 'region':
        return analysis.byRegion
      case 'instrumentType':
        return analysis.byInstrumentType
      default:
        return []
    }
  }, [dimension, analysis])

  return (
    <div className="mx-auto w-full max-w-[480px] px-4 pb-24">
      {/* 维度切换 */}
      <div className="mt-4 flex flex-wrap gap-1.5" data-testid="dimension-tabs">
        {(Object.keys(DIMENSION_LABEL) as AssetDimension[]).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDimension(d)}
            className={`rounded-full border px-3 py-1 text-[12px] ${
              dimension === d ? 'border-ink bg-ink text-s1' : 'border-line bg-s1 text-ink2'
            }`}
            data-testid={`dim-${d}`}
          >
            {DIMENSION_LABEL[d]}
          </button>
        ))}
      </div>

      {/* 分组视图 */}
      {dimension !== 'holdings' ? (
        <section className="mt-4 rounded-2xl border border-line bg-s1 p-4" data-testid="bucket-view">
          <h2 className="text-[13px] font-medium text-ink2">
            {DIMENSION_LABEL[dimension]} · 合计 {cny(analysis.reliableValueCny)}
          </h2>
          {buckets.length === 0 ? (
            <p className="mt-3 text-[12px] text-ink4">暂无数据</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {buckets.map((b) => (
                <li key={b.key} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 text-ink2">{b.label}</span>
                    <span className="text-ink">{cny(b.valueCny)}</span>
                    <span className="w-12 text-right text-ink3">
                      {b.share === undefined ? '—' : `${(b.share * 100).toFixed(1)}%`}
                    </span>
                  </div>
                  {/* 币种维度额外展示原币，避免不同币种被直接相加 */}
                  {b.nativeTotal !== undefined ? (
                    <p className="mt-0.5 text-[11px] text-ink4">
                      原币 {b.nativeTotal.toLocaleString('zh-CN')} {b.nativeCurrency}
                      {b.fxMissing ? ' · ⚠️ 缺汇率，未折算' : ''}
                    </p>
                  ) : null}
                  {!b.isComplete ? (
                    <p className="mt-0.5 text-[11px] tone-warn">
                      {b.unavailableCount > 0 ? `${b.unavailableCount} 项无法估值` : ''}
                      {b.staleCount > 0 ? ` ${b.staleCount} 项估值已过期` : ''}
                      （未计入金额）
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* 持仓明细 */}
      <section className="mt-4" data-testid="holdings-list">
        <h2 className="px-1 text-[13px] font-medium text-ink2">
          持仓（{analysis.assetRows.length + analysis.liabilityRows.length}）
        </h2>

        {analysis.rows.length === 0 ? (
          <p className="mt-3 px-1 text-[12px] text-ink4">还没有持仓数据</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {analysis.rows.map((row) => {
              const result = resultByHolding.get(row.holdingId)
              const inst = instrumentById.get(row.instrumentId)
              const account = accountById.get(row.accountId)
              return (
                <li
                  key={row.holdingId}
                  className="rounded-2xl border border-line bg-s1 p-3"
                  data-testid="holding-row"
                  data-holding-id={row.holdingId}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">{inst?.name ?? row.instrumentName}</p>
                      <p className="mt-0.5 text-[11px] text-ink4">
                        {account?.name ?? row.accountName}
                        {' · '}
                        {REGION_LABEL[row.region] ?? row.region}
                        {' · '}
                        {ASSET_CLASS_LABEL[row.assetClass as keyof typeof ASSET_CLASS_LABEL] ?? row.assetClass}
                        {row.classConfirmed ? '' : '（待确认）'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink4">
                        {INSTRUMENT_TYPE_LABEL[row.instrumentType]}
                        {' · '}
                        {row.currency}
                        {row.quantity ? ` · 数量 ${row.quantity}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* stale 与 unavailable 绝不显示成 0 */}
                      {row.status === 'ok' && row.valueCny !== undefined ? (
                        <p className="text-[13px] text-ink">{cny(row.valueCny)}</p>
                      ) : row.status === 'stale' ? (
                        <>
                          <p className="text-[12px] text-ink3">
                            最后已知 {cny(result?.nativeValue ?? 0)}
                          </p>
                          <p className="text-[10px] tone-warn">未计入可靠总额</p>
                        </>
                      ) : (
                        <p className="text-[12px] text-ink4">无法估值</p>
                      )}
                      <div className="mt-1">
                        <StatusBadge result={result} />
                      </div>
                    </div>
                  </div>

                  {row.status !== 'ok' && result?.reasons.length ? (
                    <p className="mt-1.5 text-[10px] text-ink4">原因：{result.reasons.join('、')}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* 地区维度来源说明 */}
      <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink4">
        地区维度使用 <span className="text-ink3">Account.region</span>（资产存放地），
        不根据证券名称或代码猜测所属市场。
      </p>
      <p className="mt-1 px-1 text-[11px] text-ink4">
        账户类型示例：{[...new Set(portfolio.accounts.map((a) => ACCOUNT_TYPE_LABEL[a.type]))].join(' / ') || '—'}
      </p>

      {onRegionChange && region !== undefined ? (
        <p className="mt-1 px-1 text-[11px] text-ink4">当前地区筛选：{region || '全部'}</p>
      ) : null}
    </div>
  )
}
