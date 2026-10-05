/**
 * A股分红抓取：东方财富数据中心（公开接口，CORS 开放，无需 Key）。
 *
 * 关键事实（2026-10 实测）：
 * - 报表 RPT_SHAREBONUS_DET 含**未来已公告**的除权除息日，可用来做「已确认」分红；
 * - PRETAX_BONUS_RMB 是「每 10 股」金额（字段名有误导性），这里统一换算成「每股」；
 * - IMPL_PLAN_PROFILE 文本形如 10转4股派15.00元(含税,扣税后13.50元)，税后金额从文本里解析；
 * - 过滤语法支持一次查多只：(SECURITY_CODE in ("600519","000001"))
 *
 * 只有「实施」阶段（有 EX_DIVIDEND_DATE）的记录才有日期可展示；
 * 还在「预案」阶段（除息日未定）的记录会被跳过。
 */
import type { DividendRecord } from './dividends'
import { autoRecordId } from './dividends'

const DATACENTER_URL = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const REPORT = 'RPT_SHAREBONUS_DET'
const PAGE_SIZE = 500
const MAX_PAGES = 5

export interface AshareDividendOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** 「扣税后 13.50 元」→ 13.5（每 10 股口径）；解析不到返回 undefined */
export function parseAfterTaxPer10(planText?: string): number | undefined {
  if (!planText) return undefined
  const m = planText.match(/扣税后\s*([\d.]+)\s*元/)
  if (!m) return undefined
  const v = Number(m[1])
  return Number.isFinite(v) && v > 0 ? v : undefined
}

const isoDate = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined
}

/** 东财原始记录 → 内部分红记录（无除息日的预案记录返回 null） */
export function normalizeShareBonusRow(row: Record<string, unknown>): DividendRecord | null {
  const code = typeof row.SECURITY_CODE === 'string' ? row.SECURITY_CODE.trim() : ''
  const exDate = isoDate(row.EX_DIVIDEND_DATE)
  if (!/^\d{6}$/.test(code) || !exDate) return null

  const per10 = Number(row.PRETAX_BONUS_RMB)
  const afterPer10 = parseAfterTaxPer10(typeof row.IMPL_PLAN_PROFILE === 'string' ? row.IMPL_PLAN_PROFILE : undefined)
  const bonus = Number(row.BONUS_IT_RATIO)

  return {
    // id 用「市场+代码+除息日」，重复抓取天然幂等
    id: autoRecordId('ashare', code, exDate),
    code,
    market: 'ashare',
    name: typeof row.SECURITY_NAME_ABBR === 'string' ? row.SECURITY_NAME_ABBR : undefined,
    exDate,
    recordDate: isoDate(row.EQUITY_RECORD_DATE),
    declarationDate: isoDate(row.PLAN_NOTICE_DATE),
    // 每 10 股 → 每股
    cashPerUnit: Number.isFinite(per10) && per10 > 0 ? per10 / 10 : 0,
    afterTaxPerUnit: afterPer10 !== undefined ? afterPer10 / 10 : undefined,
    bonusRatio: Number.isFinite(bonus) && bonus > 0 ? bonus : undefined,
    currency: 'CNY',
    // 接口不给派息频率：交给日历按「历史同月」推算
    frequency: 'irregular',
    source: 'auto',
    planText: typeof row.IMPL_PLAN_PROFILE === 'string' ? row.IMPL_PLAN_PROFILE : undefined,
  }
}

export function buildShareBonusUrl(codes: string[], page: number): string {
  const filter = `(SECURITY_CODE in (${codes.map((c) => `"${c}"`).join(',')}))`
  const params = new URLSearchParams({
    reportName: REPORT,
    columns: 'ALL',
    filter,
    pageSize: String(PAGE_SIZE),
    pageNumber: String(page),
    sortColumns: 'EX_DIVIDEND_DATE',
    sortTypes: '-1',
    source: 'WEB',
    client: 'WEB',
  })
  return `${DATACENTER_URL}?${params.toString()}`
}

/** 批量拉取 A股分红（含未来已公告）；失败抛错，由调用方决定是否提示 */
export async function fetchAshareDividends(
  codes: string[],
  options: AshareDividendOptions = {},
): Promise<DividendRecord[]> {
  const list = [...new Set(codes.filter((c) => /^\d{6}$/.test(c)))]
  if (list.length === 0) return []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true })

  try {
    const out: DividendRecord[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(buildShareBonusUrl(list, page), {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      if (!res.ok) throw new Error(`分红接口 HTTP ${res.status}`)
      const json: unknown = await res.json()
      const result = (json as { result?: { data?: unknown[] } } | null)?.result
      const rows = result && Array.isArray(result.data) ? result.data : []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const rec = normalizeShareBonusRow(row as Record<string, unknown>)
        if (rec) out.push(rec)
      }
      if (rows.length < PAGE_SIZE) break
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}
