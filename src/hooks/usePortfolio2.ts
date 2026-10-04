/**
 * W2 只读数据源 hook
 *
 * ## 职责边界（严格）
 *
 * ```
 * Repository → Holdings → Valuation → Analysis → Snapshot/History → **本 hook** → UI
 * ```
 *
 * 本 hook **只做「取数 + 派生一次」**：
 * - 从 Repository 读 `Portfolio2`
 * - 调用一次 `calculateTotals` 与 `deriveAnalysis`
 * - 把结果交给 UI
 *
 * **UI 组件不得重新计算金融事实**（不得自己加总、不得自己判可用性）。
 * 组件只负责展示、筛选、排序、下钻。
 *
 * ## 为什么不复用 W1 的 `usePortfolio`
 *
 * W1 的 `usePortfolio` 面向 1.0 的数据形态（`Portfolio`），属于过渡层。
 * W2 直接消费 2.0 的 `Portfolio2` + `AnalysisView`，避免多一层投影带来的口径漂移。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Portfolio2 } from '../types/portfolio2'
import { createEmptyPortfolio2 } from '../types/portfolio2'
import type { PortfolioRepository } from '../lib/db/repository'
import { createDexieRepository } from '../lib/db/dexieRepository'
import { calculateTotals, valuateHolding } from '../lib/valuation/engine'
import { createFxTable } from '../lib/valuation/fx'
import type { PortfolioTotals, ValuationResult } from '../lib/valuation/types'
import { type AnalysisView, deriveAnalysis } from '../lib/analysis'
import { detectDuplicateHoldings, type DuplicateReport } from '../lib/ledger/duplicates'
import { ensureDailySnapshot, type DailySnapshotOutcome } from '../lib/performance/dailySnapshot'
import { buildCompositionTrend, type TrendSeries } from '../lib/performance/history'

export interface Portfolio2Snapshot {
  portfolio: Portfolio2
  totals: PortfolioTotals
  results: ValuationResult[]
  analysis: AnalysisView
  duplicates: DuplicateReport
  trend: TrendSeries
  loadedAt: number
}

export interface UsePortfolio2State {
  data: Portfolio2Snapshot | null
  loading: boolean
  error: string | null
  /** 每日快照的结果（供 UI 提示，不影响主流程） */
  daily: DailySnapshotOutcome | null
  reload: () => Promise<void>
}

/**
 * 一次性把 2.0 数据派生到位。
 *
 * **纯函数**（除了读 Repository）：不写任何存储，便于测试与复用。
 */
export async function loadPortfolio2(
  repo: PortfolioRepository,
  options: { now?: number } = {},
): Promise<Portfolio2Snapshot> {
  const now = options.now ?? Date.now()
  const portfolio = await repo.loadPortfolio()
  const fx = createFxTable(portfolio.fxRates)

  const results = portfolio.holdings.map((h) => valuateHolding(h, portfolio, { fx, now }))
  const totals = calculateTotals({ portfolio, fx, now })
  const analysis = deriveAnalysis({ portfolio, results, totals, now })

  return {
    portfolio,
    totals,
    results,
    analysis,
    duplicates: detectDuplicateHoldings(portfolio),
    trend: buildCompositionTrend(portfolio.snapshots),
    loadedAt: now,
  }
}

export function usePortfolio2(repo?: PortfolioRepository): UsePortfolio2State {
  // 仓储只建一次；调用方也可注入（测试用内存实现）
  const repoRef = useRef<PortfolioRepository | null>(repo ?? null)
  if (!repoRef.current) repoRef.current = createDexieRepository()
  const activeRepo = repoRef.current

  const [data, setData] = useState<Portfolio2Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [daily, setDaily] = useState<DailySnapshotOutcome | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await loadPortfolio2(activeRepo)
      setData(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取数据失败')
    } finally {
      setLoading(false)
    }
  }, [activeRepo])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      /*
       * 每日快照先跑：它可能与读取并发，但**失败不影响读取**。
       * 刻意放在读取之前，这样首次加载就能看到今日快照。
       */
      let outcome: DailySnapshotOutcome | null = null
      try {
        outcome = await ensureDailySnapshot(activeRepo)
      } catch {
        // ensureDailySnapshot 本身不抛出；这里只是最后保险
        outcome = null
      }
      if (cancelled) return
      setDaily(outcome)

      setLoading(true)
      try {
        const next = await loadPortfolio2(activeRepo)
        if (cancelled) return
        setData(next)
        setError(null)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : '读取数据失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeRepo])

  return useMemo(
    () => ({ data, loading, error, daily, reload }),
    [data, loading, error, daily, reload],
  )
}

/** 空组合常量，供 UI 在无数据时安全渲染 */
export const EMPTY_PORTFOLIO2 = createEmptyPortfolio2()
