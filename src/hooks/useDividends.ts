import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Portfolio } from '../types/asset'
import { toCny, type FxRates } from '../lib/currency'
import {
  type DividendFile,
  type DividendMode,
  type DividendRecord,
  afterTaxPerUnit,
  applyBonusShares,
  depositToCashItem,
  findHolding,
  loadDividendFile,
  patchRecord,
  reinvestShares,
  removeRecord,
  roundMoney,
  saveDividendFile,
  setPref,
  upsertRecords,
} from '../lib/dividends'
import { fetchAshareDividends } from '../lib/dividendService'
import { collectHoldingRefs } from '../lib/calc'
import type { FundingSource } from '../lib/settings'
import type { HoldingMarket } from '../lib/usStock'

/** 自动抓取的本地缓存时长 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

export interface ApplyOutcome {
  ok: boolean
  reason?: string
  message?: string
}

/** 供组件取用 hook 的返回类型 */
export type UseDividends = ReturnType<typeof useDividends>

export interface UseDividendsOptions {
  rates?: FxRates | null
  /** 美股预扣税率 */
  taxUs?: number
  /** 港股预扣税率 */
  taxHk?: number
}

/**
 * 分红：记录状态 + A股自动抓取 + 入账动作。
 *
 * 数据存在独立键里；入账会改动持仓/现金，所以走 applyPortfolio 回写到组合。
 */
export function useDividends(
  portfolio: Portfolio,
  applyPortfolio: (p: Portfolio) => void,
  options: UseDividendsOptions = {},
) {
  const { rates, taxUs = 0.1, taxHk = 0.1 } = options
  const [file, setFile] = useState<DividendFile>(() => loadDividendFile())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    saveDividendFile(file)
  }, [file])

  /** 持仓里的 A股代码（分红自动抓取只覆盖 A股） */
  const ashareCodes = useMemo(() => {
    const set = new Set<string>()
    for (const ref of collectHoldingRefs(portfolio)) {
      if (ref.market === 'ashare') set.add(ref.code)
    }
    return [...set]
  }, [portfolio])
  const ashareKey = ashareCodes.join(',')

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (ashareCodes.length === 0 || inFlight.current) return
      inFlight.current = true
      if (!opts.silent) {
        setLoading(true)
        setError(null)
      }
      try {
        const records = await fetchAshareDividends(ashareCodes)
        const at = Date.now()
        setFile((prev) => {
          const cache = { ...prev.cache }
          for (const code of ashareCodes) cache[code] = at
          return upsertRecords({ ...prev, cache }, records)
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : '分红数据抓取失败')
      } finally {
        inFlight.current = false
        setLoading(false)
      }
    },
    [ashareCodes],
  )

  /** 打开分红页时按 TTL 自动抓一次（持仓变化也会重算） */
  useEffect(() => {
    if (ashareCodes.length === 0) return
    const newest = Math.max(0, ...ashareCodes.map((c) => file.cache[c] ?? 0))
    if (Date.now() - newest < CACHE_TTL_MS) return
    void refresh({ silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ashareKey])

  const addManual = useCallback((record: DividendRecord) => {
    setFile((prev) => upsertRecords(prev, [record]))
  }, [])

  const patch = useCallback((id: string, p: Partial<DividendRecord>) => {
    setFile((prev) => patchRecord(prev, id, p))
  }, [])

  const remove = useCallback((id: string) => {
    setFile((prev) => removeRecord(prev, id))
  }, [])

  const setMode = useCallback((market: HoldingMarket, code: string, mode: DividendMode) => {
    setFile((prev) => setPref(prev, market, code, mode))
  }, [])

  const tax = { us: taxUs, hk: taxHk }

  /** 现金分红入账：税后金额 × 份额 → 折人民币 → 加到指定账户（已入账的不会重复） */
  const applyCash = useCallback(
    (record: DividendRecord, target: FundingSource): ApplyOutcome => {
      if (record.applied) return { ok: false, reason: '这笔已经入账过了' }
      const holding = findHolding(portfolio, record)
      if (!holding) return { ok: false, reason: '找不到对应持仓（可能已被删除）' }
      const shares = Number(holding.shares) || 0
      if (shares <= 0) return { ok: false, reason: '该持仓份额为 0' }
      const amount = shares * afterTaxPerUnit(record, tax)
      const cny = toCny(amount, record.currency, rates) ?? amount
      const res = depositToCashItem(portfolio, target, roundMoney(cny))
      if (!res.ok) return { ok: false, reason: res.reason }
      applyPortfolio(res.portfolio)
      setFile((prev) => patchRecord(prev, record.id, { applied: true, appliedAt: Date.now() }))
      return { ok: true, message: `已入账 ${roundMoney(cny)} 元` }
    },
    [portfolio, rates, tax.us, tax.hk, applyPortfolio],
  )

  /** 分红再投资：按给定价格（默认除息日净值/收盘价）折算份额，成本按加权平均 */
  const applyReinvest = useCallback(
    (record: DividendRecord, price: number): ApplyOutcome => {
      if (record.applied) return { ok: false, reason: '这笔已经入账过了' }
      const holding = findHolding(portfolio, record)
      if (!holding) return { ok: false, reason: '找不到对应持仓（可能已被删除）' }
      if (!(price > 0)) return { ok: false, reason: '请填写再投资价格（除息日净值 / 收盘价）' }
      const shares = Number(holding.shares) || 0
      const add = (shares * afterTaxPerUnit(record, tax)) / price
      if (!(add > 0)) return { ok: false, reason: '折算份额为 0，请检查份额与价格' }
      const res = reinvestShares(portfolio, holding.id, add, price)
      if (!res.ok) return { ok: false, reason: res.reason }
      applyPortfolio(res.portfolio)
      setFile((prev) => patchRecord(prev, record.id, { applied: true, appliedAt: Date.now() }))
      return { ok: true, message: `已增加 ${add.toFixed(4)} 份` }
    },
    [portfolio, tax.us, tax.hk, applyPortfolio],
  )

  /** 送股/转股：份额按比例增加、成本同比例摊薄（**必须用户确认后**才调用） */
  const applyBonus = useCallback(
    (record: DividendRecord): ApplyOutcome => {
      if (!record.bonusRatio || record.bonusRatio <= 0) return { ok: false, reason: '这笔没有送转比例' }
      if (record.bonusApplied) return { ok: false, reason: '这笔送转已经应用过了' }
      const holding = findHolding(portfolio, record)
      if (!holding) return { ok: false, reason: '找不到对应持仓（可能已被删除）' }
      const res = applyBonusShares(portfolio, holding.id, record.bonusRatio)
      if (!res.ok) return { ok: false, reason: res.reason }
      applyPortfolio(res.portfolio)
      setFile((prev) => patchRecord(prev, record.id, { bonusApplied: true }))
      return { ok: true, message: `份额已按「10 送转 ${record.bonusRatio} 股」调整` }
    },
    [portfolio, applyPortfolio],
  )

  return {
    file,
    records: file.records,
    prefs: file.prefs,
    loading,
    error,
    ashareCodes,
    refresh,
    addManual,
    patch,
    remove,
    setMode,
    applyCash,
    applyReinvest,
    applyBonus,
  }
}
