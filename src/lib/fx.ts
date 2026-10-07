/**
 * 汇率服务
 *
 * 实测结论（2026-10）：
 * - open.er-api.com  ✅ 200 且 `Access-Control-Allow-Origin: *`，免密钥，166 个币种，每日更新
 * - cdn.jsdelivr.net 的 @fawazahmed0/currency-api ✅ 200 且带 CORS，作为备用
 * - api.frankfurter.app ❌ 301 跳转；api.exchangerate.host ❌ 现在强制要求 API Key
 *
 * 因此这里做「主 + 备」双通道，任一成功即写缓存；全部失败时回退到本地缓存的汇率，
 * 保证纯前端、离线也能用上次的汇率继续算。
 */

import { fxFallbackRates } from './fxFallback'
import {
  CURRENCY_CODES,
  CURRENCY_STORAGE_KEY,
  type CurrencyCode,
  type FxRates,
  hasUsableRates,
  isFxStale,
} from './currency'

const PRIMARY = 'https://open.er-api.com/v6/latest/CNY'
const BACKUP = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json'

export interface FxResult {
  rates: FxRates
  /** 本次是否真的走了网络（false 表示用了缓存） */
  fromNetwork: boolean
  /** 网络失败时的原因，便于界面提示 */
  error?: string
  /** 是否用的内置参考汇率（实时失败且无缓存） */
  builtin?: boolean
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

export function loadCachedRates(): FxRates | null {
  try {
    const raw = window.localStorage.getItem(CURRENCY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as FxRates
    if (!parsed || typeof parsed !== 'object' || !parsed.perCny) return null
    return parsed
  } catch {
    return null
  }
}

export function saveCachedRates(rates: FxRates): void {
  try {
    window.localStorage.setItem(CURRENCY_STORAGE_KEY, JSON.stringify(rates))
  } catch {
    /* 存不下就算了，本次仍能用内存里的汇率 */
  }
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** 只挑我们支持的币种，避免把 160 多个汇率全塞进 localStorage */
function pickSupported(source: Record<string, unknown>): Partial<Record<CurrencyCode, number>> {
  const out: Partial<Record<CurrencyCode, number>> = { CNY: 1 }
  for (const code of CURRENCY_CODES) {
    if (code === 'CNY') continue
    const raw = source[code] ?? source[code.toLowerCase()]
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(n) && n > 0) out[code] = n
  }
  return out
}

export function parsePrimary(payload: unknown): FxRates {
  const p = payload as { result?: string; rates?: Record<string, unknown>; time_last_update_utc?: string } | null
  if (!p || p.result !== 'success' || !p.rates) throw new Error('主接口返回格式异常')
  const perCny = pickSupported(p.rates)
  if (Object.keys(perCny).length <= 1) throw new Error('主接口没有我们支持的币种')
  return {
    perCny,
    fetchedAt: Date.now(),
    source: 'open.er-api.com',
    updatedAt: typeof p.time_last_update_utc === 'string' ? p.time_last_update_utc : undefined,
  }
}

export function parseBackup(payload: unknown): FxRates {
  const p = payload as { date?: string; cny?: Record<string, unknown> } | null
  if (!p || !p.cny) throw new Error('备用接口返回格式异常')
  const perCny = pickSupported(p.cny)
  if (Object.keys(perCny).length <= 1) throw new Error('备用接口没有我们支持的币种')
  return {
    perCny,
    fetchedAt: Date.now(),
    source: 'jsdelivr/currency-api',
    updatedAt: typeof p.date === 'string' ? p.date : undefined,
  }
}

/* ------------------------------------------------------------------ *
 * 拉取
 * ------------------------------------------------------------------ */

async function fetchJson(url: string, timeout: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export interface FetchFxOptions {
  /** 单次请求超时（毫秒） */
  timeout?: number
  /** 忽略缓存直接拉取 */
  force?: boolean
  /** 缓存未过期时不发请求（默认 true） */
  skipIfFresh?: boolean
}

/**
 * 取汇率：优先用未过期的缓存，否则走网络（主 → 备），全失败则退回缓存。
 * 无论成功与否都不会抛错 —— 汇率不是本应用的核心依赖，缺了也要能正常记账。
 */
export async function fetchRates(options: FetchFxOptions = {}): Promise<FxResult> {
  const { timeout = 10_000, force = false, skipIfFresh = true } = options
  const cached = loadCachedRates()

  if (!force && skipIfFresh && hasUsableRates(cached) && !isFxStale(cached)) {
    return { rates: cached as FxRates, fromNetwork: false }
  }

  const attempts: string[] = []
  for (const [url, parse, label] of [
    [PRIMARY, parsePrimary, 'open.er-api.com'],
    [BACKUP, parseBackup, 'jsdelivr/currency-api'],
  ] as const) {
    try {
      const rates = parse(await fetchJson(url, timeout))
      saveCachedRates(rates)
      return { rates, fromNetwork: true }
    } catch (e) {
      attempts.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const error = attempts.join('；')
  if (hasUsableRates(cached)) {
    return { rates: cached as FxRates, fromNetwork: false, error }
  }
  // 最后一级兜底：内置参考汇率（首次打开就没网 / 清过数据时用）
  // 至少给出数量级正确的总额，而不是把美元当人民币；界面会标明日期并提示联网后更新。
  return { rates: fxFallbackRates(), fromNetwork: false, error, builtin: true }
}
