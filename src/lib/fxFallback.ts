/**
 * 内置参考汇率 —— 汇率兜底的**最后一级**。
 *
 * 什么时候才会用到它：**实时接口两路都失败，且本地没有缓存**。
 * 典型场景：第一次打开 App 就没网（地铁、飞机、朋友发链接第一次打开）、清过浏览器数据。
 * 没有它的话，外币只能「按原币数值当人民币」计入总额 —— 100 美元会被当成 100 元，差 7 倍。
 *
 * ⚠️ 三条硬约束（改这里之前先读）：
 * 1. **绝不冒充实时**：source 固定为 `builtin`，界面必须写明这是内置参考值 + 日期；
 * 2. 只在「实时失败且无缓存」时使用，一旦联网立即换成实时值；
 * 3. 汇率天然会过期 —— 发版前顺手刷新一次（见下面的更新方式），别让它漂太久。
 *
 * 更新方式：抓 `https://open.er-api.com/v6/latest/CNY`（base 就是 CNY，字段即 perCny），
 * 把 11 个币种的值填到 FALLBACK_PER_CNY，并把 FX_FALLBACK_AS_OF 改成数据日期。
 */

import { type CurrencyCode, type FxRates } from './currency'

/** 内置数据的数据日期（界面会显示出来） */
export const FX_FALLBACK_AS_OF = '2026-10-07'

/** 内置数据的来源标识 */
export const FX_FALLBACK_SOURCE = 'open.er-api.com'

/**
 * 1 人民币 = 多少该币种（与 FxRates.perCny 同义）。
 * 数据日期见 FX_FALLBACK_AS_OF，来源 open.er-api.com（每日更新）。
 */
const FALLBACK_PER_CNY: Record<CurrencyCode, number> = {
  CNY: 1,
  USD: 0.148989,
  HKD: 1.169234,
  SGD: 0.190161,
  JPY: 23.57456,
  EUR: 0.132433,
  GBP: 0.112318,
  AUD: 0.213751,
  KRW: 201.694232,
  TWD: 4.750594,
  CAD: 0.211739,
}

/** 内置数据日期对应的本地时间戳（当天 0 点） */
export function fallbackAsOfTimestamp(): number {
  const parsed = Date.parse(FX_FALLBACK_AS_OF + 'T00:00:00')
  return Number.isFinite(parsed) ? parsed : 0
}

/** 内置参考汇率（source 固定 'builtin'，界面据此标注） */
export function fxFallbackRates(): FxRates {
  return {
    perCny: { ...FALLBACK_PER_CNY },
    fetchedAt: fallbackAsOfTimestamp(),
    source: 'builtin',
    updatedAt: FX_FALLBACK_AS_OF,
  }
}

/** 这份汇率是不是内置兜底（而不是实时/缓存来的） */
export function isBuiltinRates(rates: FxRates | null | undefined): boolean {
  return rates?.source === 'builtin'
}

/** 供测试与界面使用：内置表里有哪些币种 */
export function builtinRateCodes(): CurrencyCode[] {
  return Object.keys(FALLBACK_PER_CNY) as CurrencyCode[]
}
