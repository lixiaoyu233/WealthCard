import type { HistoryPoint, Portfolio } from '../types/asset'
import { SCHEMA_VERSION, createDefaultCategories, createEmptyPortfolio, mergeDefaultCategories } from './defaults'
import { isCurrencyCode } from './currency'
import { safeNum } from './calc'

// 键名刻意保留早期前缀（项目曾用名 asset-card-wallet）：改名不迁移数据，老用户无感
export const STORAGE_KEY = 'asset-card-wallet/portfolio/v2'
/**
 * 记录「已经向该用户提供过」的内置分类 id。
 *
 * 没有这份记忆就无法区分「用户主动删掉了国债」和「老数据里从来没有国债」，
 * 于是删除的内置分类每次启动都会被补回来并弹一次升级提示。
 * 这是新增键（不改名、不动主数据结构），前缀仍在 1.0 自己的 asset-card-wallet/ 命名空间内。
 */
export const CATEGORY_INTRO_KEY = 'asset-card-wallet/category-intro/v1'
/** 兜底：旧版本键名，迁移后保留只读读取 */
const LEGACY_KEYS = ['asset-card-wallet/portfolio/v1', 'assetCardWallet', 'asset-card-wallet']

export interface StorageResult {
  portfolio: Portfolio
  /** 是否从损坏数据中恢复（用于给用户提示） */
  recovered: boolean
  /** 版本升级时自动补上的内置分类名称（用于一次性提示） */
  addedCategories?: string[]
  error?: string
}

/** localStorage 可用性探测（隐私模式 / 禁用 Cookie 时会抛错） */
export function isStorageAvailable(): boolean {
  try {
    const k = '__acw_probe__'
    window.localStorage.setItem(k, '1')
    window.localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}

function isCategoryLike(v: unknown): v is { id: string; name: string; items: unknown[] } {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.items)
}

/**
 * 把任意来源的数据（localStorage / 旧版本 / 手工导入）规范化为当前 Schema。
 * 任何字段缺失都补默认值，保证 UI 永远不会因为脏数据崩溃。
 */
export function normalizePortfolio(raw: unknown): Portfolio | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const rawCategories = Array.isArray(obj.categories) ? obj.categories : null
  if (!rawCategories) return null

  const categories = rawCategories.filter(isCategoryLike).map((c, idx) => {
    const raw0 = c as unknown as Record<string, unknown>
    const fallback = createDefaultCategories()[idx]
    const items = (c.items as unknown[]).map(normalizeItem).filter((i): i is NonNullable<typeof i> => i !== null)
    return {
      id: String(c.id),
      name: String(c.name || fallback?.name || '未命名分类'),
      subtitle: typeof raw0.subtitle === 'string' ? raw0.subtitle : (fallback?.subtitle ?? ''),
      icon: typeof raw0.icon === 'string' ? raw0.icon : (fallback?.icon ?? 'wallet'),
      color: typeof raw0.color === 'string' && raw0.color ? raw0.color : (fallback?.color ?? 'var(--accent-blue)'),
      colorName: typeof raw0.colorName === 'string' ? raw0.colorName : fallback?.colorName,
      isLiability: raw0.isLiability === true,
      defaultKind:
        raw0.defaultKind === 'fund' || raw0.defaultKind === 'gold' || raw0.defaultKind === 'amount'
          ? raw0.defaultKind
          : fallback?.defaultKind,
      items,
    }
  })

  const history: HistoryPoint[] = Array.isArray(obj.history)
    ? (obj.history as unknown[])
        .map((h) => {
          if (!h || typeof h !== 'object') return null
          const p = h as Record<string, unknown>
          if (typeof p.date !== 'string') return null
          return {
            date: p.date,
            netWorth: safeNum(p.netWorth),
            totalAssets: safeNum(p.totalAssets),
            totalLiabilities: safeNum(p.totalLiabilities),
            at: safeNum(p.at) || Date.now(),
          }
        })
        .filter((h): h is HistoryPoint => h !== null)
        .slice(-120)
    : []

  /**
   * 分类为空数组是「用户把分类全删了」的显式状态，必须原样保留
   * （UI 有对应的空状态，见 App.tsx）。只有「有内容但没有一条合法」的脏数据
   * 才回退默认分类，避免脏数据让界面变空。
   */
  const normalizedCategories =
    categories.length > 0 || rawCategories.length === 0 ? categories : createDefaultCategories()

  return {
    version: SCHEMA_VERSION,
    categories: normalizedCategories,
    history,
    lastSyncedAt: typeof obj.lastSyncedAt === 'number' ? obj.lastSyncedAt : undefined,
  }
}

function normalizeItem(raw: unknown): Portfolio['categories'][number]['items'][number] | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' && o.id ? o.id : `item_${Math.random().toString(36).slice(2, 10)}`
  const kind = o.kind === 'fund' || o.kind === 'gold' ? o.kind : 'amount'
  const name = typeof o.name === 'string' && o.name ? o.name : '未命名'

  if (kind === 'fund') {
    /**
     * 代码清洗必须区分市场：早期统一按「只留数字」处理，
     * 会把 SPY / QQQ 这类美股字母代码清成空字符串，导致持仓永远拿不到行情。
     */
    const rawCode = typeof o.code === 'string' ? o.code.trim() : ''
    // ⚠️ 白名单必须包含 ashare：漏掉它会让 A股/场内持仓在重新加载后退化成场外基金
    const isMarket = (v: unknown): v is 'cn' | 'ashare' | 'us' | 'hk' =>
      v === 'us' || v === 'hk' || v === 'cn' || v === 'ashare'
    const rawMarket = isMarket(o.market) ? o.market : undefined
    const code =
      rawMarket === 'us'
        ? rawCode.toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 6)
        : rawCode.replace(/\D/g, '').slice(0, 6)
    return {
      id,
      kind: 'fund',
      name,
      note: typeof o.note === 'string' ? o.note : undefined,
      code,
      market: rawMarket,
      // 人工标记的资产类型（旧字段，仍作为「手动占比」的兼容来源）与债券期限都要留住
      assetClass:
        o.assetClass === 'equity' ||
        o.assetClass === 'bond' ||
        o.assetClass === 'money' ||
        o.assetClass === 'commodity' ||
        o.assetClass === 'mixed' ||
        o.assetClass === 'unknown'
          ? o.assetClass
          : undefined,
      bondTerm: o.bondTerm === 'long' || o.bondTerm === 'mid' ? o.bondTerm : undefined,
      shares: safeNum(o.shares),
      costNav: safeNum(o.costNav),
      manualNav:
        typeof o.manualNav === 'number' && Number.isFinite(o.manualNav) && o.manualNav > 0
          ? o.manualNav
          : undefined,
      manualName: o.manualName === true,
      fundedFrom: (() => {
        const f = o.fundedFrom
        if (!f || typeof f !== 'object') return undefined
        const r = f as Record<string, unknown>
        if (typeof r.categoryId !== 'string' || typeof r.itemId !== 'string') return undefined
        return {
          categoryId: r.categoryId,
          itemId: r.itemId,
          itemName: typeof r.itemName === 'string' ? r.itemName : '现金项目',
          amount: safeNum(r.amount),
        }
      })(),
      quote: normalizeQuote(o.quote),
    }
  }

  // 币种只接受白名单内的取值；非法/缺失一律回落人民币，保证旧数据兼容
  const currency = typeof o.currency === 'string' && o.currency !== 'CNY' && isCurrencyCode(o.currency)
    ? o.currency
    : undefined

  const bondTerm = o.bondTerm === 'long' || o.bondTerm === 'mid' ? o.bondTerm : undefined

  if (kind === 'gold') {
    return {
      id,
      kind: 'gold',
      name,
      note: typeof o.note === 'string' ? o.note : undefined,
      grams: safeNum(o.grams),
      pricePerGram: safeNum(o.pricePerGram),
      currency,
      bondTerm,
    }
  }

  return {
    id,
    kind: 'amount',
    name,
    note: typeof o.note === 'string' ? o.note : undefined,
    amount: safeNum(o.amount),
    currency,
    bondTerm,
  }
}

function normalizeQuote(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const q = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  return {
    code: str(q.code) ?? '',
    name: str(q.name) ?? '',
    estimatedNav: num(q.estimatedNav),
    estimatedRate: num(q.estimatedRate),
    estimatedAt: str(q.estimatedAt),
    publishedNav: num(q.publishedNav),
    publishedRate: num(q.publishedRate),
    publishedAt: str(q.publishedAt),
    fetchedAt: num(q.fetchedAt) ?? 0,
    source: str(q.source) ?? 'cache',
  }
}

/* ------------------------------------------------------------------ *
 * 内置分类的「已提供」标记（区分「用户删了」与「老数据没有」）
 * ------------------------------------------------------------------ */

function readIntroducedCategories(): Set<string> {
  try {
    const raw = window.localStorage.getItem(CATEGORY_INTRO_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    // 标记损坏时退化为旧行为（缺失即补），不影响用户数据
    return new Set()
  }
}

/** 把本版本的内置分类全部记为「已提供」；写失败（如空间已满）只是退化为旧行为 */
function markBuiltInCategoriesIntroduced(): void {
  try {
    const next = new Set([...readIntroducedCategories(), ...createDefaultCategories().map((c) => c.id)])
    const serialized = JSON.stringify([...next])
    if (window.localStorage.getItem(CATEGORY_INTRO_KEY) !== serialized) {
      window.localStorage.setItem(CATEGORY_INTRO_KEY, serialized)
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 补内置分类 + 落标记。
 * 空数组代表用户把分类全删了（UI 有空状态），是合法状态，不能当作老数据补默认分类。
 */
function withMergedBuiltInCategories(portfolio: Portfolio, recovered: boolean): StorageResult {
  const merged =
    portfolio.categories.length === 0
      ? { categories: portfolio.categories, added: [] as string[] }
      : mergeDefaultCategories(portfolio.categories, readIntroducedCategories())
  const addedNames = merged.added.map((id) => merged.categories.find((c) => c.id === id)?.name ?? id)
  markBuiltInCategoriesIntroduced()
  return {
    portfolio: { ...portfolio, categories: merged.categories },
    recovered,
    addedCategories: addedNames.length > 0 ? addedNames : undefined,
  }
}

/** 读取本地数据；损坏时自动回退默认值并标记 recovered */
export function loadPortfolio(): StorageResult {
  if (!isStorageAvailable()) {
    return { portfolio: createEmptyPortfolio(), recovered: true, error: '当前浏览器禁用了本地存储，数据无法保存' }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = normalizePortfolio(JSON.parse(raw))
      if (parsed) return withMergedBuiltInCategories(parsed, false)
      markBuiltInCategoriesIntroduced()
      return { portfolio: createEmptyPortfolio(), recovered: true, error: '本地数据格式异常，已重置为默认分类' }
    }
    // 迁移旧键（同样要走内置分类补齐，否则从旧键迁移过来的人第一次打开拿不到「国债」）
    for (const key of LEGACY_KEYS) {
      const legacy = window.localStorage.getItem(key)
      if (!legacy) continue
      const parsed = normalizePortfolio(JSON.parse(legacy))
      if (parsed) return withMergedBuiltInCategories(parsed, false)
    }
    // 首次使用：先把本版本的内置分类记为「已提供」，用户随后删除才能真正生效
    markBuiltInCategoriesIntroduced()
    return { portfolio: createEmptyPortfolio(), recovered: false }
  } catch (e) {
    return {
      portfolio: createEmptyPortfolio(),
      recovered: true,
      error: e instanceof Error ? `本地数据读取失败：${e.message}` : '本地数据读取失败',
    }
  }
}

/** 写入本地数据，返回 null 表示成功，否则返回错误文案 */
export function savePortfolio(portfolio: Portfolio): string | null {
  if (!isStorageAvailable()) return '当前浏览器禁用了本地存储，数据无法保存'
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio))
    return null
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22)) {
      return '本地存储空间已满，请清理浏览器数据后重试'
    }
    return e instanceof Error ? `保存失败：${e.message}` : '保存失败'
  }
}

export function exportPortfolio(portfolio: Portfolio): string {
  return JSON.stringify(portfolio, null, 2)
}

export function clearPortfolio(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
    // 标记必须跟主数据一起清掉，否则残留的「已提供」记录会和新数据不一致
    window.localStorage.removeItem(CATEGORY_INTRO_KEY)
  } catch {
    /* 忽略 */
  }
}
