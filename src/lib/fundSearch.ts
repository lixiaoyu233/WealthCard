/**
 * 按名称查基金代码 → 拿净值 → 反推份额。
 *
 * 为什么这么分工：截图（尤其是平台总览页）常常只有「名称 + 金额」，
 * 而落库需要代码（行情/穿透/分红都靠它）与份额（算盈亏靠它）。
 * 让 AI 去猜代码和份额 = 让它编数字；这里用**真实接口 + 可复现的算术**补上，
 * 并把每个数字的出处标出来（截图 / 名称搜到 / 由净值推算 / 由收益反推）。
 *
 * 实测：fundsuggest 搜索接口支持 JSONP（cb 包裹，几 KB），
 * 一次会返回同一只基金的 A/C/I 等多类份额（如 016452/016453/021000），需要挑选。
 */
import { jsonp } from './jsonp'
import { basicInfoUrl, parseBasicInformation } from './assetMixService'
import type { FieldSource, ParsedHolding } from './holdingImport'

export interface FundCandidate {
  code: string
  name: string
  category?: string
}

export const FUND_SEARCH_URL = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx'

export const searchFundUrl = (key: string): string =>
  `${FUND_SEARCH_URL}?m=1&key=${encodeURIComponent(key)}`

/* ------------------------------------------------------------------ *
 * 名称规范化与挑选（纯函数）
 * ------------------------------------------------------------------ */

/** 全角括号 → 半角、去空白与间隔号；用于比较，不改展示用的原名 */
export function normalizeFundName(name: string | undefined): string {
  return (name ?? '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[·・\s]/g, '')
    .trim()
}

/** 搜素关键字：去掉结尾的份额字母（A/C/I/E），免得只搜到某一类 */
export function searchKeyOf(name: string): string {
  return normalizeFundName(name)
    .replace(/\([^)]*\)(?=[A-Z]?$)/, '') // 去掉结尾括号里的限定（如 (QDII)）——保留主体
    .replace(/[A-Z]$/, '')
    .replace(/[()]/g, '')
    .trim() || normalizeFundName(name)
}

const isCClass = (name: string) => /\)?C$/.test(normalizeFundName(name))
const isAClass = (name: string) => /\)?A$/.test(normalizeFundName(name))

/**
 * 从候选里挑一个：
 * 1) 规范化后完全相等 → 直接用它（多个时优先 A 类）
 * 2) 否则按"公共前缀长度 + A 类偏好"排序取第一，并标记 ambiguous（界面要给用户换）
 */
export function pickFundCandidate(
  wantName: string,
  candidates: FundCandidate[],
): { best?: FundCandidate; ambiguous: boolean } {
  if (candidates.length === 0) return { ambiguous: false }
  const want = normalizeFundName(wantName)
  const exact = candidates.filter((c) => normalizeFundName(c.name) === want)
  const pool = exact.length > 0 ? exact : candidates
  const score = (c: FundCandidate) => {
    let s = 0
    const n = normalizeFundName(c.name)
    let i = 0
    while (i < Math.min(n.length, want.length) && n[i] === want[i]) i += 1
    s += i
    // 同等条件下优先 A 类（A 类最常见），C 类次之
    if (isAClass(c.name)) s += 1000
    else if (!isCClass(c.name)) s += 500
    return s
  }
  const sorted = [...pool].sort((a, b) => score(b) - score(a))
  return { best: sorted[0], ambiguous: pool.length > 1 }
}

/** 名称是否足够相似（用于「官方名称 vs 截图名称」的提醒） */
export function nameSimilar(a: string | undefined, b: string | undefined): boolean {
  const x = normalizeFundName(a)
  const y = normalizeFundName(b)
  if (!x || !y) return true
  if (x === y) return true
  let i = 0
  while (i < Math.min(x.length, y.length) && x[i] === y[i]) i += 1
  return i / Math.max(x.length, y.length) >= 0.6
}

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseFundSearch(json: unknown): FundCandidate[] {
  const rows = isRecord(json) ? json.Datas : undefined
  if (!Array.isArray(rows)) return []
  const out: FundCandidate[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const code = typeof row.CODE === 'string' ? row.CODE : ''
    const name = typeof row.NAME === 'string' ? row.NAME : ''
    if (!/^\d{6}$/.test(code) || !name) continue
    const category = typeof row.CATEGORYDESC === 'string' ? row.CATEGORYDESC : undefined
    out.push({ code, name, category })
  }
  return out
}

export interface SearchOptions {
  timeoutMs?: number
}

/**
 * 按名称搜索候选（几 KB）。
 *
 * 双通道，和基金行情的做法一致：
 * 1. CORS fetch —— Node / 测试环境可用，浏览器里会被 CORS 拦掉（快速失败）
 * 2. JSONP —— 浏览器里用 <script> 绕开 CORS
 */
export async function searchFund(key: string, options: SearchOptions = {}): Promise<FundCandidate[]> {
  if (!key.trim()) return []
  const url = searchFundUrl(key)
  const timeout = options.timeoutMs ?? 12_000

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const init: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer' }
      let res: Response
      try {
        res = await fetch(url, { ...init, signal: controller.signal })
      } catch (e) {
        if (e instanceof TypeError && /signal/i.test(e.message)) res = await fetch(url, init)
        else throw e
      }
      if (res.ok) {
        const parsed = parseFundSearch(JSON.parse(await res.text()))
        if (parsed.length > 0) return parsed
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    /* 落到 JSONP */
  }

  try {
    const payload = await jsonp(url, {
      callbackKey: 'callback',
      timeout,
      prefix: '__acw_fund_search',
    })
    return parseFundSearch(payload)
  } catch {
    return []
  }
}

/** 取基金基本信息：官方名称 / 基金类型 / 单位净值 / 净值日期 */
export async function fetchFundBasic(
  code: string,
  options: SearchOptions = {},
): Promise<ReturnType<typeof parseBasicInformation>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  try {
    const url = basicInfoUrl(code)
    const init: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer' }
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: controller.signal })
    } catch (e) {
      // jsdom + undici 混用时 signal 类不同源，退化成不带超时
      if (e instanceof TypeError && /signal/i.test(e.message)) res = await fetch(url, init)
      else throw e
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseBasicInformation(JSON.parse(await res.text()))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 汇总：给一行解析结果补代码 / 份额 / 成本
 * ------------------------------------------------------------------ */

export interface Enrichment {
  code?: string
  officialName?: string
  ftype?: string
  nav?: number
  navDate?: string
  shares?: number
  costNav?: number
  sources: { code?: FieldSource; shares?: FieldSource; cost?: FieldSource }
  candidates?: FundCandidate[]
  /** 给界面显示的中文提示（不阻断导入） */
  notes: string[]
}

export interface EnrichOptions extends SearchOptions {
  /** 允许联网（测试里可关掉） */
  online?: boolean
  /** 测试用：直接注入搜索结果，跳过网络 */
  candidatesOverride?: FundCandidate[]
  /** 测试用：直接注入基金基本信息，跳过网络 */
  basicOverride?: { name?: string; ftype?: string; nav?: number; navDate?: string }
}

export async function enrichHolding(holding: ParsedHolding, options: EnrichOptions = {}): Promise<Enrichment> {
  const online = options.online !== false
  const notes: string[] = []
  const sources: Enrichment['sources'] = {}
  let code = holding.code.trim()
  let officialName: string | undefined
  let ftype: string | undefined
  let nav: number | undefined
  let navDate: string | undefined
  let candidates: FundCandidate[] | undefined

  if (code) {
    sources.code = 'screenshot'
  } else if (options.candidatesOverride) {
    candidates = options.candidatesOverride
    const picked = pickFundCandidate(holding.name ?? '', candidates)
    if (picked.best) {
      code = picked.best.code
      officialName = picked.best.name
      sources.code = 'name-search'
      if (picked.ambiguous) notes.push(`「${holding.name}」匹配到 ${candidates.length} 个份额，已选 ${picked.best.name}`)
    } else {
      notes.push(`没搜到「${holding.name}」的代码，可手动填或保持按金额记账`)
    }
  } else if (online && holding.name) {
    candidates = await searchFund(searchKeyOf(holding.name), options)
    const picked = pickFundCandidate(holding.name, candidates)
    if (picked.best) {
      code = picked.best.code
      officialName = picked.best.name
      sources.code = 'name-search'
      if (picked.ambiguous) {
        notes.push(`「${holding.name}」匹配到 ${candidates.length} 个份额，已选 ${picked.best.name}，可在预览里改`)
      }
    } else {
      notes.push(`没搜到「${holding.name}」的代码，可手动填或保持按金额记账`)
    }
  }

  if (options.basicOverride) {
    officialName = options.basicOverride.name ?? officialName
    ftype = options.basicOverride.ftype
    nav = options.basicOverride.nav
    navDate = options.basicOverride.navDate
  } else if (online && code) {
    const basic = await fetchFundBasic(code, options)
    if (basic) {
      officialName = basic.name ?? officialName
      ftype = basic.ftype
      nav = basic.nav
      navDate = basic.navDate
    }
  }

  if (officialName && holding.name && !nameSimilar(holding.name, officialName)) {
    notes.push(`官方名称是「${officialName}」，与截图里的「${holding.name}」不完全一致，请核对`)
  }

  // 份额：截图优先，缺了就用「金额 ÷ 净值」推
  let shares = holding.shares
  if (shares > 0) {
    sources.shares = 'screenshot'
  } else if (holding.amount && nav && nav > 0) {
    shares = holding.amount / nav
    sources.shares = 'derived-nav'
    notes.push(`份额按 ${navDate ?? '最新'} 净值 ${nav} 由市值推算（${shares.toFixed(2)} 份）`)
  }

  // 成本：截图 > （金额 − 持仓收益）÷ 份额 > 净值兜底
  let costNav = holding.costNav
  if (costNav !== undefined) {
    sources.cost = holding.sources?.cost && holding.sources.cost !== 'none' ? holding.sources.cost : 'screenshot'
  } else if (shares > 0) {
    if (holding.amount !== undefined && holding.profit !== undefined) {
      costNav = (holding.amount - holding.profit) / shares
      sources.cost = 'derived-profit'
    } else if (nav) {
      costNav = nav
      sources.cost = 'fallback-nav'
    }
  }

  if (shares > 0 && nav && holding.amount && Math.abs(shares * nav - holding.amount) / holding.amount > 0.02) {
    notes.push('份额 × 净值 与金额差超过 2%，请核对（可能是净值日期不同或份额抄错）')
  }

  return {
    code: code || undefined,
    officialName,
    ftype,
    nav,
    navDate,
    shares: shares > 0 ? shares : undefined,
    costNav,
    sources,
    candidates,
    notes,
  }
}
