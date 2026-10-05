import type { UseDividends } from '../hooks/useDividends'
import { createEmptyDividendFile } from '../lib/dividends'

/** 组件测试用的空分红状态替身（需要时用 overrides 覆盖） */
export function makeDividends(overrides: Partial<UseDividends> = {}): UseDividends {
  return {
    file: createEmptyDividendFile(),
    records: [],
    prefs: {},
    loading: false,
    error: null,
    ashareCodes: [],
    refresh: async () => {},
    addManual: () => {},
    patch: () => {},
    remove: () => {},
    setMode: () => {},
    applyCash: () => ({ ok: true }),
    applyReinvest: () => ({ ok: true }),
    applyBonus: () => ({ ok: true }),
    ...overrides,
  }
}
