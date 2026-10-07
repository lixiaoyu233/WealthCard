import { describe, expect, it } from 'vitest'
import { CURRENCY_CODES } from './currency'
import {
  FX_FALLBACK_AS_OF,
  FX_FALLBACK_SOURCE,
  builtinRateCodes,
  fallbackAsOfTimestamp,
  fxFallbackRates,
  isBuiltinRates,
} from './fxFallback'

describe('内置参考汇率（汇率兜底的最后一级）', () => {
  it('覆盖全部支持的币种，且 CNY 恒为 1', () => {
    const codes = builtinRateCodes().sort()
    expect(codes).toEqual([...CURRENCY_CODES].sort())
    const rates = fxFallbackRates()
    expect(rates.perCny.CNY).toBe(1)
  })

  it('每个币种都是正的有限数（防止手改表时写坏）', () => {
    for (const [code, value] of Object.entries(fxFallbackRates().perCny)) {
      expect(Number.isFinite(value), code).toBe(true)
      expect(value as number).toBeGreaterThan(0)
    }
  })

  it('金额级数量级与常识相符（USD / HKD / JPY 抽查）', () => {
    const { perCny } = fxFallbackRates()
    // 1 人民币 ≈ 0.14 美元、≈1.17 港币、≈23.5 日元
    expect(perCny.USD!).toBeGreaterThan(0.1)
    expect(perCny.USD!).toBeLessThan(0.2)
    expect(perCny.HKD!).toBeGreaterThan(1)
    expect(perCny.HKD!).toBeLessThan(1.4)
    expect(perCny.JPY!).toBeGreaterThan(15)
    expect(perCny.JPY!).toBeLessThan(35)
  })

  it('来源固定为 builtin，并带数据日期（绝不冒充实时）', () => {
    const rates = fxFallbackRates()
    expect(rates.source).toBe('builtin')
    expect(rates.updatedAt).toBe(FX_FALLBACK_AS_OF)
    expect(FX_FALLBACK_SOURCE).toBe('open.er-api.com')
    expect(FX_FALLBACK_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('isBuiltinRates 只认 builtin', () => {
    expect(isBuiltinRates(fxFallbackRates())).toBe(true)
    expect(isBuiltinRates({ perCny: { CNY: 1 }, fetchedAt: Date.now(), source: 'open.er-api.com' })).toBe(false)
    expect(isBuiltinRates(null)).toBe(false)
    expect(isBuiltinRates(undefined)).toBe(false)
  })

  it('fetchedAt 是数据日期当天 0 点（界面据此显示日期）', () => {
    const ts = fallbackAsOfTimestamp()
    expect(ts).toBeGreaterThan(0)
    const d = new Date(ts)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
  })

  it('内置汇率真的能让外币折算（不再把美元当人民币）', async () => {
    const { toCny } = await import('./currency')
    const rates = fxFallbackRates()
    // 100 美元 ≈ 671 元（而不是 100 元）
    expect(toCny(100, 'USD', rates)).toBeCloseTo(100 / 0.148989, 2)
    expect(toCny(1000, 'HKD', rates)).toBeCloseTo(1000 / 1.169234, 2)
    expect(toCny(100, 'CNY', rates)).toBe(100)
  })

  it('返回的是副本（调用方改坏不影响下次）', () => {
    const a = fxFallbackRates()
    a.perCny.USD = 999
    expect(fxFallbackRates().perCny.USD).toBeCloseTo(0.148989, 6)
  })
})


describe('汇率兜底链：实时 → 缓存 → 内置', () => {
  it('实时与缓存都拿不到时用内置参考汇率，并标记 builtin', async () => {
    const { fetchRates } = await import('./fx')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    try {
      const res = await fetchRates({ force: true, timeout: 50 })
      expect(res.fromNetwork).toBe(false)
      expect(res.builtin).toBe(true)
      expect(res.rates.source).toBe('builtin')
      // 关键：不再是「只剩 CNY」的空汇率，外币能折算
      expect(res.rates.perCny.USD).toBeGreaterThan(0)
      expect(res.error).toContain('open.er-api.com')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
