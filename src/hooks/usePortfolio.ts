import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AssetItem,
  Category,
  FundItem,
  FundQuote,
  GoldItem,
  HistoryPoint,
  Portfolio,
} from '../types/asset'
import { CATEGORY_COLORS, SCHEMA_VERSION, createDefaultCategories } from '../lib/defaults'
import { collectFundCodes, isFund, safeNum, summarize } from '../lib/calc'
import { loadPortfolio, savePortfolio } from '../lib/storage'
import { todayKey } from '../lib/format'
import { uid } from '../lib/id'
import { FundServiceError, fetchFundQuotes } from '../lib/fundService'

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

type Action =
  | { type: 'replace'; portfolio: Portfolio }
  | { type: 'addCategory'; category: Category }
  | { type: 'updateCategory'; id: string; patch: Partial<Omit<Category, 'items' | 'id'>> }
  | { type: 'removeCategory'; id: string }
  | { type: 'moveCategory'; id: string; dir: -1 | 1 }
  | { type: 'addItem'; categoryId: string; item: AssetItem }
  | { type: 'updateItem'; categoryId: string; itemId: string; item: AssetItem }
  | { type: 'removeItem'; categoryId: string; itemId: string }
  | { type: 'mergeQuotes'; quotes: FundQuote[]; at: number }
  | { type: 'snapshot'; point: HistoryPoint }

function mapCategory(portfolio: Portfolio, id: string, fn: (c: Category) => Category): Portfolio {
  return { ...portfolio, categories: portfolio.categories.map((c) => (c.id === id ? fn(c) : c)) }
}

function reducer(state: Portfolio, action: Action): Portfolio {
  switch (action.type) {
    case 'replace':
      return action.portfolio

    case 'addCategory':
      return { ...state, categories: [...state.categories, action.category] }

    case 'updateCategory':
      return mapCategory(state, action.id, (c) => ({ ...c, ...action.patch }))

    case 'removeCategory':
      return { ...state, categories: state.categories.filter((c) => c.id !== action.id) }

    case 'moveCategory': {
      const idx = state.categories.findIndex((c) => c.id === action.id)
      const target = idx + action.dir
      if (idx < 0 || target < 0 || target >= state.categories.length) return state
      const categories = [...state.categories]
      ;[categories[idx], categories[target]] = [categories[target], categories[idx]]
      return { ...state, categories }
    }

    case 'addItem':
      return mapCategory(state, action.categoryId, (c) => ({ ...c, items: [...c.items, action.item] }))

    case 'updateItem':
      return mapCategory(state, action.categoryId, (c) => ({
        ...c,
        items: c.items.map((i) => (i.id === action.itemId ? action.item : i)),
      }))

    case 'removeItem':
      return mapCategory(state, action.categoryId, (c) => ({
        ...c,
        items: c.items.filter((i) => i.id !== action.itemId),
      }))

    case 'mergeQuotes': {
      if (action.quotes.length === 0) return state
      const byCode = new Map<string, FundQuote>()
      for (const q of action.quotes) byCode.set(q.code, q)
      let touched = false
      const categories = state.categories.map((c) => {
        let nextItems: AssetItem[] | null = null
        c.items.forEach((item, i) => {
          if (!isFund(item)) return
          const quote = byCode.get(item.code)
          if (!quote) return
          if (!nextItems) nextItems = [...c.items]
          nextItems[i] = {
            ...item,
            quote,
            name: item.manualName ? item.name : quote.name || item.name,
          } as FundItem
          touched = true
        })
        return nextItems ? { ...c, items: nextItems } : c
      })
      return touched ? { ...state, categories, lastSyncedAt: action.at } : { ...state, lastSyncedAt: action.at }
    }

    case 'snapshot': {
      const rest = state.history.filter((h) => h.date !== action.point.date)
      return { ...state, history: [...rest, action.point].slice(-120) }
    }

    default:
      return state
  }
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export interface SyncState {
  loading: boolean
  lastError?: string
  lastSuccessAt?: number
  /** 最后一次命中的行情通道 */
  source?: string
}

const initialLoad = loadPortfolio()

export function usePortfolio() {
  const [portfolio, dispatch] = useReducer(reducer, initialLoad.portfolio)
  const [storageError, setStorageError] = useState<string | null>(initialLoad.error ?? null)
  const [recovered, setRecovered] = useState(initialLoad.recovered)
  const [sync, setSync] = useState<SyncState>({ loading: false })
  const bootstrapped = useRef(false)
  const inFlight = useRef(false)

  /* ---------- 持久化：任何变更都写入 localStorage ---------- */
  useEffect(() => {
    const err = savePortfolio(portfolio)
    if (err) setStorageError(err)
  }, [portfolio])

  const summary = useMemo(() => summarize(portfolio), [portfolio])
  const fundCodes = useMemo(() => collectFundCodes(portfolio), [portfolio])

  /** 记录当日净资产快照，用于「较上次」变化提示 */
  const takeSnapshot = useCallback((p: Portfolio) => {
    const s = summarize(p)
    dispatch({
      type: 'snapshot',
      point: {
        date: todayKey(),
        netWorth: s.netWorth,
        totalAssets: s.totalAssets,
        totalLiabilities: s.totalLiabilities,
        at: Date.now(),
      },
    })
  }, [])

  /** 拉取基金行情并回填 */
  const syncQuotes = useCallback(
    async (codes?: string[], opts: { silent?: boolean } = {}) => {
      const list = (codes ?? fundCodes).filter((c) => /^\d{6}$/.test(c))
      if (list.length === 0) return
      if (inFlight.current) return
      inFlight.current = true
      if (!opts.silent) setSync((s) => ({ ...s, loading: true, lastError: undefined }))
      try {
        const map = await fetchFundQuotes(list)
        const quotes: FundQuote[] = []
        let source: string | undefined
        for (const [code, hit] of map) {
          quotes.push(hit.quote)
          if (code === list[0]) source = hit.source
        }
        dispatch({ type: 'mergeQuotes', quotes, at: Date.now() })
        setSync({ loading: false, lastSuccessAt: Date.now(), source })
      } catch (e) {
        const msg =
          e instanceof FundServiceError
            ? `${e.message}${e.attempts.length ? `（${e.attempts.map((a) => a.error).join('；')}）` : ''}`
            : e instanceof Error
              ? e.message
              : '行情同步失败'
        setSync({ loading: false, lastError: msg })
      } finally {
        inFlight.current = false
      }
    },
    [fundCodes],
  )

  /* ---------- 启动：首屏自动同步一次（有基金时） ---------- */
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    if (fundCodes.length > 0) void syncQuotes(fundCodes, { silent: true })
    // 仅在首次挂载运行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- 每 5 分钟静默刷新（页面可见时） ---------- */
  useEffect(() => {
    if (fundCodes.length === 0) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncQuotes(fundCodes, { silent: true })
    }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [fundCodes, syncQuotes])

  /** 记录快照（净资产变化时） */
  useEffect(() => {
    const timer = window.setTimeout(() => takeSnapshot(portfolio), 1200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.netWorth])

  /* ---------- 分类操作 ---------- */
  const addCategory = useCallback((patch?: Partial<Category>) => {
    const category: Category = {
      id: uid('cat'),
      name: patch?.name?.trim() || '新分类',
      subtitle: patch?.subtitle ?? '',
      icon: patch?.icon ?? 'wallet',
      color: patch?.color ?? CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)],
      isLiability: patch?.isLiability ?? false,
      items: [],
    }
    dispatch({ type: 'addCategory', category })
    return category.id
  }, [])

  const updateCategory = useCallback(
    (id: string, patch: Partial<Omit<Category, 'items' | 'id'>>) => dispatch({ type: 'updateCategory', id, patch }),
    [],
  )
  const removeCategory = useCallback((id: string) => dispatch({ type: 'removeCategory', id }), [])
  const moveCategory = useCallback((id: string, dir: -1 | 1) => dispatch({ type: 'moveCategory', id, dir }), [])

  /* ---------- 条目操作 ---------- */
  const addItem = useCallback((categoryId: string, item: AssetItem) => dispatch({ type: 'addItem', categoryId, item }), [])
  const updateItem = useCallback(
    (categoryId: string, item: AssetItem) => dispatch({ type: 'updateItem', categoryId, itemId: item.id, item }),
    [],
  )
  const removeItem = useCallback(
    (categoryId: string, itemId: string) => dispatch({ type: 'removeItem', categoryId, itemId }),
    [],
  )

  /** 清空全部数据，恢复默认分类 */
  const resetAll = useCallback(() => {
    dispatch({
      type: 'replace',
      portfolio: { version: SCHEMA_VERSION, categories: createDefaultCategories(), history: [] },
    })
    setRecovered(false)
  }, [])

  const importPortfolio = useCallback((p: Portfolio) => dispatch({ type: 'replace', portfolio: p }), [])

  return {
    portfolio,
    summary,
    fundCodes,
    sync,
    storageError,
    recovered,
    dismissRecovered: () => setRecovered(false),
    syncQuotes,
    addCategory,
    updateCategory,
    removeCategory,
    moveCategory,
    addItem,
    updateItem,
    removeItem,
    resetAll,
    importPortfolio,
  }
}

/** 表单提交时构造条目；金额与份额的数值解析在表单层完成 */
export function makeAmountItem(input: { name: string; note?: string; amount: number }): AssetItem {
  return { id: uid('item'), kind: 'amount', name: input.name, note: input.note, amount: safeNum(input.amount) }
}

export function makeFundItem(input: {
  id?: string
  name?: string
  code: string
  shares: number
  costNav: number
  note?: string
  quote?: FundQuote
}): FundItem {
  return {
    id: input.id ?? uid('fund'),
    kind: 'fund',
    name: input.name?.trim() || input.code,
    note: input.note,
    code: input.code,
    shares: safeNum(input.shares),
    costNav: safeNum(input.costNav),
    quote: input.quote,
  }
}

export function makeGoldItem(input: {
  id?: string
  name: string
  grams: number
  pricePerGram: number
  note?: string
}): GoldItem {
  return {
    id: input.id ?? uid('gold'),
    kind: 'gold',
    name: input.name,
    note: input.note,
    grams: safeNum(input.grams),
    pricePerGram: safeNum(input.pricePerGram),
  }
}
