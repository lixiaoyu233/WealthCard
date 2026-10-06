/**
 * 资产占比取数：从东财移动端接口拿「基金类型 + 资产配置占比」，算出一笔持仓的穿透占比。
 *
 * 实测（2026-10）：
 * - 两个接口都开放 CORS，无需代理/Key：
 *   FundMNBasicInformation（基金类型、全称、净值）
 *   FundMNAssetAllocationNew（股/债/现金/其他 占净比 + 报告期）
 * - 只覆盖**中国上市**的基金与 ETF（含场内 QDII）。美股/港股上市的 ETF（SPY/QQQ）没有数据
 *   → 返回 undefined，交给名称推测或手动设置。
 * - 数据是**季报**口径（报告期滞后最多约 3 个月），所以缓存 7 天、界面要显示报告期。
 */
import type { AssetMix } from '../types/strategy'
import { mixFromAllocation, normalizeMix, type AllocationRow } from './assetMix'

export const ASSET_MIX_CACHE_KEY = 'asset-card-wallet/asset-mix/v1'
/** 季报频率，7 天足够；过期不清空，只标记「数据可能过期」 */
export const MIX_TTL_MS = 7 * 24 * 60 * 60 * 1000

const BASE = 'https://fundmobapi.eastmoney.com/FundMNewApi'
const TAIL = 'plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1'

export const allocationUrl = (code: string): string =>
  `${BASE}/FundMNAssetAllocationNew?FCODE=${code}&${TAIL}`
export const basicInfoUrl = (code: string): string => `${BASE}/FundMNBasicInformation?FCODE=${code}&${TAIL}`

/** 能拉取的市场：只有中国上市基金/ETF */
export const canFetchMix = (market: string | undefined, code: string): boolean => {
  const m = market ?? 'cn'
  return (m === 'cn' || m === 'ashare') && /^\d{6}$/.test(code.trim())
}

export const mixKey = (market: string | undefined, code: string): string =>
  `${market ?? 'cn'}:${code.trim().toUpperCase()}`

export interface MixEntry {
  mix: AssetMix
  /** 报告期（季报） */
  reportDate?: string
  /** 基金类型，如「指数型-股票」 */
  ftype?: string
  /** 基金全称 */
  name?: string
  fetchedAt: number
}

export type MixCache = Record<string, MixEntry>

/* ------------------------------------------------------------------ *
 * 解析（纯函数，便于单测）
 * ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseBasicInformation(json: unknown): { name?: string; ftype?: string } | undefined {
  const data = isRecord(json) ? json.Datas : undefined
  if (!isRecord(data)) return undefined
  const name = typeof data.SHORTNAME === 'string' ? data.SHORTNAME : undefined
  const ftype = typeof data.FTYPE === 'string' ? data.FTYPE : undefined
  if (!name && !ftype) return undefined
  return { name, ftype }
}

export function parseAllocationPayload(json: unknown): AllocationRow | undefined {
  const rows = isRecord(json) ? json.Datas : undefined
  if (!Array.isArray(rows) || rows.length === 0) return undefined
  const first = rows[0]
  if (!isRecord(first)) return undefined
  const pick = (k: string) => (typeof first[k] === 'string' ? (first[k] as string) : undefined)
  const row: AllocationRow = { FSRQ: pick('FSRQ'), GP: pick('GP'), ZQ: pick('ZQ'), HB: pick('HB'), QT: pick('QT') }
  return row
}

/** 把两个接口的结果合成一条缓存记录；占比解析不出来时返回 undefined */
export function buildMixEntry(
  basic: { name?: string; ftype?: string } | undefined,
  row: AllocationRow | undefined,
  now: number,
): MixEntry | undefined {
  const mix = mixFromAllocation(row, { ftype: basic?.ftype, name: basic?.name })
  if (!mix) return undefined
  const empty = mix.equity + mix.bond + mix.money + mix.gold + mix.commodity + mix.other <= 0
  if (empty) return undefined
  return {
    mix: normalizeMix(mix),
    reportDate: typeof row?.FSRQ === 'string' ? row.FSRQ.slice(0, 10) : undefined,
    ftype: basic?.ftype,
    name: basic?.name,
    fetchedAt: now,
  }
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

export function normalizeMixCache(raw: unknown): MixCache {
  if (!isRecord(raw)) return {}
  const out: MixCache = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.mix)) continue
    const mix = normalizeMix(value.mix as Partial<AssetMix>)
    if (mix.equity + mix.bond + mix.money + mix.gold + mix.commodity + mix.other <= 0) continue
    out[key] = {
      mix,
      reportDate: typeof value.reportDate === 'string' ? value.reportDate.slice(0, 10) : undefined,
      ftype: typeof value.ftype === 'string' ? value.ftype : undefined,
      name: typeof value.name === 'string' ? value.name : undefined,
      fetchedAt: Number(value.fetchedAt) || 0,
    }
  }
  return out
}

export function loadMixCache(): MixCache {
  try {
    const raw = window.localStorage.getItem(ASSET_MIX_CACHE_KEY)
    if (!raw) return {}
    return normalizeMixCache(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveMixCache(cache: MixCache): string | null {
  try {
    window.localStorage.setItem(ASSET_MIX_CACHE_KEY, JSON.stringify(cache))
    return null
  } catch (e) {
    return e instanceof Error ? `资产占比缓存保存失败：${e.message}` : '资产占比缓存保存失败'
  }
}

/** 缓存是否仍在有效期内 */
export const mixFresh = (entry: MixEntry | undefined, now: number): boolean =>
  !!entry && now - entry.fetchedAt < MIX_TTL_MS

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

const FETCH_INIT: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer' }

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { ...FETCH_INIT, signal })
  } catch (e) {
    // 某些环境里 AbortController 与 fetch 不是同一实现（实测 jsdom + undici 混用），
    // 传 signal 会直接抛 TypeError → 退化成「不带超时」再试一次，别让整个取数失败。
    if (e instanceof TypeError && /signal/i.test(e.message)) {
      res = await fetch(url, FETCH_INIT)
    } else {
      throw e
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  // 用 text + JSON.parse 而不是 res.json()：接口 content-type/charset 不规范，
  // res.json() 在部分环境会直接抛错，而返回体是纯 ASCII JSON。
  return JSON.parse(await res.text())
}

export interface FetchMixOptions {
  timeoutMs?: number
  now?: number
}

/** 拉一只基金的资产占比（中国上市基金/ETF 才有）；失败/无数据返回 undefined */
export async function fetchAssetMix(code: string, options: FetchMixOptions = {}): Promise<MixEntry | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  const now = options.now ?? Date.now()
  try {
    // 基本信息决定「货币基金/黄金 ETF」这两个特例，先拿它
    let basic: { name?: string; ftype?: string } | undefined
    try {
      basic = parseBasicInformation(await fetchJson(basicInfoUrl(code), controller.signal))
    } catch {
      basic = undefined
    }
    const row = parseAllocationPayload(await fetchJson(allocationUrl(code), controller.signal))
    return buildMixEntry(basic, row, now)
  } catch {
    // 拉不到就让上层走名称推测/手动设置（hook 会记下失败，不反复重试）
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
