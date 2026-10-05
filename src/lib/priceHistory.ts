/**
 * 除息日历史价格（用于「分红再投资」折算份额）。
 *
 * ⚠️ 必须用**不复权**价格：前复权会把分红造成的下跌抹掉，
 * 用它算份额会算错。腾讯要传空复权参数拿到 `day`，东财用 fqt=0。
 *
 * 实测（2026-10）各市场可得性：
 * - A股 / 场内：腾讯不复权日K ✅（与东财 push2his 交叉验证一致：1271.10）
 * - 港股：腾讯不复权日K ✅
 * - 场外基金：天天基金移动端历史净值 ✅
 * - 美股：腾讯只返回当天 1 行、东财 secid 试过 105/106/107 都不支持 → 暂缺，手填
 */
import { addMonths } from './dividendCalendar'
import { toTencentSymbol, type HoldingMarket } from './usStock'

export interface DayBar {
  date: string
  close: number
}

const TENCENT_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const FUND_NAV = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList'

/** 腾讯日K地址：复权参数留空 = 不复权 */
export function tencentHistoryUrl(symbol: string, start: string, end: string): string {
  return `${TENCENT_KLINE}?param=${symbol},day,${start},${end},320,`
}

/** 天天基金历史净值地址（移动端接口，CORS 开放） */
export function fundNavHistoryUrl(code: string, pageSize = 200): string {
  return `${FUND_NAV}?FCODE=${code}&pageIndex=1&pageSize=${pageSize}&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=1`
}

/** 解析腾讯日K：[日期, 开, 收, 高, 低, 量, ...] */
export function parseTencentDayBars(json: unknown, symbol: string): DayBar[] {
  const block = (json as { data?: Record<string, Record<string, unknown>> } | null)?.data?.[symbol]
  const rows = block && Array.isArray(block.day) ? (block.day as unknown[]) : []
  const out: DayBar[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const date = String(row[0] ?? '').slice(0, 10)
    const close = Number(row[2])
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) out.push({ date, close })
  }
  return out
}

/** 解析天天基金历史净值：FSRQ 日期 + DWJZ 单位净值 */
export function parseFundNavBars(json: unknown): DayBar[] {
  const rows = (json as { Datas?: unknown[] } | null)?.Datas
  if (!Array.isArray(rows)) return []
  const out: DayBar[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const date = typeof r.FSRQ === 'string' ? r.FSRQ.slice(0, 10) : ''
    const close = Number(r.DWJZ)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) out.push({ date, close })
  }
  return out
}

/** 取「≤ 指定日期」的最近一根收盘价（除息日遇停牌/非交易日时兜底） */
export function closeOnOrBefore(bars: DayBar[], date: string): number | undefined {
  const hit = [...bars].filter((b) => b.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0]
  return hit?.close
}

export interface PriceHistoryOptions {
  timeoutMs?: number
}

/**
 * 取某个市场某只标的在指定日期（或之前最近交易日）的不复权收盘价。
 * 美股暂不支持 → 返回 undefined，由界面提示手填。
 */
export async function fetchCloseOnDate(
  market: HoldingMarket,
  code: string,
  date: string,
  options: PriceHistoryOptions = {},
): Promise<number | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
  try {
    if (market === 'us') return undefined
    if (market === 'cn') {
      const res = await fetch(fundNavHistoryUrl(code), {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return closeOnOrBefore(parseFundNavBars(await res.json()), date)
    }
    const symbol = toTencentSymbol(code, market)
    const start = addMonths(date, -1)
    const res = await fetch(tencentHistoryUrl(symbol, start, date), {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return closeOnOrBefore(parseTencentDayBars(await res.json(), symbol), date)
  } finally {
    clearTimeout(timer)
  }
}
