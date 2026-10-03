import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Portfolio } from '../types/asset'
import type { CategoryMapping, MappingEntry, Strategy, StrategySettings, StrategyId } from '../types/strategy'
import { cloneStrategy, createCustomStrategy } from '../lib/strategies'
import {
  createDefaultSettings,
  defaultMappingFor,
  effectiveMapping,
  rebalanceWithSettings,
  resolveStrategy,
} from '../lib/rebalance'

// 键名刻意保留早期前缀，避免改名后丢失已保存的策略配置
const STORAGE_KEY = 'asset-card-wallet/strategy/v1'

/* ------------------------------------------------------------------ *
 * 读取 / 规范化
 * ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeMapping(raw: unknown): CategoryMapping {
  if (!isRecord(raw)) return {}
  const out: CategoryMapping = {}
  for (const [categoryId, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue
    const list: MappingEntry[] = []
    for (const e of entries) {
      if (!isRecord(e)) continue
      const strategyClassId = typeof e.strategyClassId === 'string' ? e.strategyClassId : ''
      const percent = Number(e.percent)
      if (!strategyClassId || !Number.isFinite(percent) || percent <= 0) continue
      list.push({ strategyClassId, percent })
    }
    if (list.length > 0) out[categoryId] = list
  }
  return out
}

function normalizeStrategy(raw: unknown): Strategy | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) return null
  const classes = Array.isArray(raw.classes)
    ? raw.classes
        .map((c, i) => {
          if (!isRecord(c)) return null
          const cid = typeof c.id === 'string' && c.id ? c.id : `class_${i}`
          const name = typeof c.name === 'string' && c.name ? c.name : `类别 ${i + 1}`
          const target = Number(c.target)
          return {
            id: cid,
            name,
            target: Number.isFinite(target) ? target : 0,
            color: typeof c.color === 'string' && c.color ? c.color : '#3b82f6',
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
    : []
  if (classes.length === 0) return null
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '自定义策略',
    kind: 'custom',
    description: typeof raw.description === 'string' ? raw.description : '',
    classes,
  }
}

/** 把任意来源的数据规范化为当前 Schema（脏数据不影响使用） */
export function normalizeSettings(raw: unknown): StrategySettings {
  const base = createDefaultSettings()
  if (!isRecord(raw)) return base

  const customStrategies = Array.isArray(raw.customStrategies)
    ? raw.customStrategies.map(normalizeStrategy).filter((s): s is Strategy => s !== null)
    : []

  const mappings: Record<string, CategoryMapping> = {}
  if (isRecord(raw.mappings)) {
    for (const [strategyId, mapping] of Object.entries(raw.mappings)) {
      const normalized = normalizeMapping(mapping)
      if (Object.keys(normalized).length > 0) mappings[strategyId] = normalized
    }
  }

  const threshold = Number(raw.threshold)
  return {
    version: 1,
    activeStrategyId: typeof raw.activeStrategyId === 'string' ? raw.activeStrategyId : base.activeStrategyId,
    customStrategies,
    mappings,
    threshold: Number.isFinite(threshold) ? Math.min(50, Math.max(0, threshold)) : base.threshold,
    includeLiabilities: raw.includeLiabilities === true,
    unmappedPolicy: raw.unmappedPolicy === 'ignore' ? 'ignore' : 'auto',
  }
}

function loadSettings(): StrategySettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return createDefaultSettings()
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return createDefaultSettings()
  }
}

function persist(settings: StrategySettings): string | null {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    return null
  } catch (e) {
    return e instanceof Error ? `策略配置保存失败：${e.message}` : '策略配置保存失败'
  }
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export function useStrategy(portfolio: Portfolio) {
  const [settings, setSettings] = useState<StrategySettings>(() => loadSettings())
  const [storageError, setStorageError] = useState<string | null>(null)

  useEffect(() => {
    const err = persist(settings)
    if (err) setStorageError(err)
  }, [settings])

  const strategy = useMemo(() => resolveStrategy(settings), [settings])

  /**
   * 当前策略下「每个分类最终生效的映射」（用户设置 > 内置默认 > 关键词兜底），
   * 供设置面板回显；计算与它保持一致。
   */
  const mapping = useMemo(() => {
    const user = settings.mappings[strategy.id]
    const out: CategoryMapping = {}
    for (const category of portfolio.categories) {
      out[category.id] = effectiveMapping(strategy, category, user)
    }
    return out
  }, [settings.mappings, strategy, portfolio])

  /** 内置默认映射，供「恢复默认」按钮对比 */
  const defaultMapping = useMemo(() => {
    const out: CategoryMapping = {}
    for (const category of portfolio.categories) {
      out[category.id] = defaultMappingFor(strategy, category)
    }
    return out
  }, [strategy, portfolio])

  const result = useMemo(() => rebalanceWithSettings(portfolio, settings), [portfolio, settings])

  /* ---------------- 操作 ---------------- */

  const setActiveStrategy = useCallback((id: StrategyId) => {
    setSettings((s) => ({ ...s, activeStrategyId: id }))
  }, [])

  const setThreshold = useCallback((threshold: number) => {
    setSettings((s) => ({ ...s, threshold: Math.min(50, Math.max(0, threshold)) }))
  }, [])

  const setFlag = useCallback(
    <K extends 'includeLiabilities' | 'unmappedPolicy'>(key: K, value: StrategySettings[K]) => {
      setSettings((s) => ({ ...s, [key]: value }))
    },
    [],
  )

  /** 写入某个分类在当前策略下的映射 */
  const setCategoryMapping = useCallback(
    (categoryId: string, entries: MappingEntry[]) => {
      setSettings((s) => {
        const current = s.mappings[s.activeStrategyId] ?? {}
        const next: CategoryMapping = { ...current }
        const clean = entries.filter((e) => e.strategyClassId && e.percent > 0)
        if (clean.length === 0) delete next[categoryId]
        else next[categoryId] = clean
        return { ...s, mappings: { ...s.mappings, [s.activeStrategyId]: next } }
      })
    },
    [],
  )

  /** 把当前策略的映射恢复为内置默认 */
  const resetMapping = useCallback(() => {
    setSettings((s) => {
      const next = { ...s.mappings }
      delete next[s.activeStrategyId]
      return { ...s, mappings: next }
    })
  }, [])

  /** 新增自定义策略（返回新策略，便于 UI 立刻切过去） */
  const addCustomStrategy = useCallback((draft?: Strategy) => {
    const created = draft ? cloneStrategy(draft) : createCustomStrategy()
    setSettings((s) => ({
      ...s,
      customStrategies: [...s.customStrategies, created],
      activeStrategyId: created.id,
    }))
    return created
  }, [])

  const updateCustomStrategy = useCallback((id: StrategyId, patch: Partial<Omit<Strategy, 'id' | 'kind'>>) => {
    setSettings((s) => ({
      ...s,
      customStrategies: s.customStrategies.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }))
  }, [])

  const removeCustomStrategy = useCallback((id: StrategyId) => {
    setSettings((s) => ({
      ...s,
      customStrategies: s.customStrategies.filter((c) => c.id !== id),
      activeStrategyId: s.activeStrategyId === id ? baseStrategyId(s) : s.activeStrategyId,
    }))
  }, [])

  return {
    settings,
    strategy,
    result,
    mapping,
    defaultMapping,
    storageError,
    setActiveStrategy,
    setThreshold,
    setFlag,
    setCategoryMapping,
    resetMapping,
    addCustomStrategy,
    updateCustomStrategy,
    removeCustomStrategy,
    /** 便于测试与「重置为默认」 */
    replaceSettings: (next: StrategySettings) => setSettings(normalizeSettings(next)),
  }
}

function baseStrategyId(s: StrategySettings): StrategyId {
  if (s.customStrategies.length > 1) {
    const first = s.customStrategies.find((c) => c.id !== s.activeStrategyId)
    if (first) return first.id
  }
  return createDefaultSettings().activeStrategyId
}
