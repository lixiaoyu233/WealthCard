import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AssetItem, Portfolio } from '../types/asset'
import type { AssetMix } from '../types/strategy'
import { isFund } from '../lib/calc'
import {
  type MixCache,
  type MixEntry,
  canFetchMix,
  fetchAssetMix,
  loadMixCache,
  mixFresh,
  mixKey,
  saveMixCache,
} from '../lib/assetMixService'

export interface UseAssetMix {
  cache: MixCache
  loading: boolean
  error: string | null
  /** 还没拿到数据、需要拉取的标的数 */
  pending: number
  /** 有缓存但已过期（仍在使用，界面可提示「数据可能过期」） */
  staleCount: number
  /** 某条目的穿透占比（未命中返回 undefined，交给名称/形态兜底） */
  autoMixOf: (item: AssetItem) => { mix: AssetMix; origin: 'api' } | undefined
  /** 缓存明细（报告期 / 基金类型 / 名称），界面用来展示来源 */
  entryOf: (item: AssetItem) => MixEntry | undefined
  /** 拉取缺失/过期的资产占比；force=true 时全部重拉 */
  refresh: (force?: boolean) => Promise<{ fetched: number; failed: number }>
}

const CONCURRENCY = 4

/**
 * 穿透取数：只为「中国上市的基金/ETF」拉资产占比，缓存 7 天（季报频率）。
 *
 * 设计要点：
 * - 拉失败不影响主流程：拿不到就走名称推测/手动设置（绝不阻塞渲染）
 * - 同一个标的失败过就不再自动重试，避免每次渲染都打接口（手动 refresh(true) 可以重来）
 * - 过期缓存继续用，只是标记出来；不会因为过期就把已识别的结果清空
 */
export function useAssetMix(portfolio: Portfolio): UseAssetMix {
  const [cache, setCache] = useState<MixCache>(() => loadMixCache())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef(cache)
  cacheRef.current = cache
  const failedRef = useRef<Set<string>>(new Set())

  /** 需要穿透的标的（去重） */
  const targets = useMemo(() => {
    const out: Array<{ key: string; code: string }> = []
    const seen = new Set<string>()
    for (const category of portfolio.categories) {
      for (const item of category.items) {
        if (!isFund(item)) continue
        const market = item.market ?? 'cn'
        if (!canFetchMix(market, item.code)) continue
        const key = mixKey(market, item.code)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ key, code: item.code.trim() })
      }
    }
    return out
  }, [portfolio.categories])

  const refresh = useCallback(
    async (force = false) => {
      const now = Date.now()
      const todo = targets.filter(
        (t) => (force || !mixFresh(cacheRef.current[t.key], now)) && (force || !failedRef.current.has(t.key)),
      )
      if (todo.length === 0) return { fetched: 0, failed: 0 }
      setLoading(true)
      setError(null)
      let fetched = 0
      let failed = 0
      const next: MixCache = { ...cacheRef.current }
      for (let i = 0; i < todo.length; i += CONCURRENCY) {
        const batch = todo.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          batch.map(async (t) => ({ key: t.key, entry: await fetchAssetMix(t.code) })),
        )
        for (const { key, entry } of results) {
          if (entry) {
            next[key] = entry
            failedRef.current.delete(key)
            fetched += 1
          } else {
            failedRef.current.add(key)
            failed += 1
          }
        }
      }
      cacheRef.current = next
      setCache(next)
      const saveError = saveMixCache(next)
      if (saveError) setError(saveError)
      setLoading(false)
      return { fetched, failed }
    },
    [targets],
  )

  /** 打开应用 / 新增标的时后台补数据（同一个失败标的不会反复重试） */
  useEffect(() => {
    if (loading || targets.length === 0) return
    const now = Date.now()
    const need = targets.some(
      (t) => !mixFresh(cacheRef.current[t.key], now) && !failedRef.current.has(t.key),
    )
    if (need) void refresh(false)
  }, [targets, refresh, loading])

  const entryOf = useCallback(
    (item: AssetItem): MixEntry | undefined => {
      if (!isFund(item)) return undefined
      return cache[mixKey(item.market ?? 'cn', item.code)]
    },
    [cache],
  )

  const autoMixOf = useCallback(
    (item: AssetItem): { mix: AssetMix; origin: 'api' } | undefined => {
      const entry = entryOf(item)
      if (!entry) return undefined
      return { mix: entry.mix, origin: 'api' }
    },
    [entryOf],
  )

  const { pending, staleCount } = useMemo(() => {
    const now = Date.now()
    let pendingCount = 0
    let stale = 0
    for (const t of targets) {
      const entry = cache[t.key]
      if (!entry) {
        if (!failedRef.current.has(t.key)) pendingCount += 1
        continue
      }
      if (!mixFresh(entry, now)) stale += 1
    }
    return { pending: pendingCount, staleCount: stale }
  }, [targets, cache])

  return { cache, loading, error, pending, staleCount, autoMixOf, entryOf, refresh }
}
