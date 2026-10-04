/**
 * 估值引擎的类型契约
 *
 * ## 核心不变量：不可估值 ≠ 价值为 0
 *
 * 当某项资产因为 FX 缺失、Quote 缺失/过期/失败、或金额本身缺失而**无法可靠估值**时：
 *
 * 1. `status` 必须是 `unavailable`（或 `stale`），**绝不返回 0 冒充有效值**；
 * 2. `value` 保持 `undefined`，不参与总额累加；
 * 3. 必须给出可读的 `reasons`，让 UI 能告诉用户「哪几项没算进去」；
 * 4. 汇总层用 `unavailableCount` / `staleCount` 如实上报，**不静默排除**，
 *    否则用户会误以为总资产是完整准确的。
 *
 * 具体反例（需求明确禁止）：
 * - USD 10,000 + FX 缺失 → 不能变成 CNY 0
 * - USD 10,000 + FX 缺失 → 也不能按 1:1 变成 CNY 10,000
 * - 正确结果：CNY 估值 unavailable，`unavailableCount + 1`，不计入 totalAssets
 */

import type { AssetClass, CurrencyCode } from '../../types/portfolio2'

/* ------------------------------------------------------------------ *
 * 估值状态
 * ------------------------------------------------------------------ */

export type ValuationStatus =
  /** 已可靠估值，value 可参与总额 */
  | 'ok'
  /** 无法可靠估值（缺 FX / 缺 Quote / Quote 失败 / 缺金额），value 为 undefined */
  | 'unavailable'
  /** 有值但依据已过期（如过期行情），value 仅供展示，**默认不计入总额** */
  | 'stale'

/** 不可估值 / 降级的具体原因，供 UI 分门别类提示 */
export type ValuationReason =
  | 'missing_fx'
  | 'stale_fx'
  | 'missing_quote'
  | 'stale_quote'
  | 'error_quote'
  | 'closed_quote'
  | 'missing_value'
  | 'missing_instrument'
  | 'missing_account'

export const VALUATION_REASON_LABEL: Record<ValuationReason, string> = {
  missing_fx: '缺少汇率',
  stale_fx: '汇率已过期',
  missing_quote: '缺少行情',
  stale_quote: '行情已过期',
  error_quote: '行情获取失败',
  closed_quote: '行情已收盘（非最新）',
  missing_value: '未记录金额',
  missing_instrument: '资产标的缺失',
  missing_account: '未归属账户',
}

/* ------------------------------------------------------------------ *
 * 单条估值结果
 * ------------------------------------------------------------------ */

export interface ValuationResult {
  holdingId: string
  status: ValuationStatus
  /**
   * 人民币估值。
   * - `status === 'ok'` 时必定有值；
   * - `unavailable` 时**必定为 undefined**（不允许用 0 代替）。
   */
  value?: number
  /** 原币估值（status 为 ok/stale 时可能有值） */
  valueInCurrency?: number
  /** 该持仓的计价币种 */
  currency: CurrencyCode
  /**
   * **原币价值**（尽量给出，与可靠性无关）。
   *
   * 三个来源，按优先级：
   * 1. 可用估值的原币金额（ok / stale）
   * 2. 参考值（例如成本价兜底）
   * 3. 数量 × 手动单价（现金与手动口径）
   *
   * ⚠️ 用途仅限**按币种展示原币敞口**（见 `byCurrency`）。
   * 它**绝不参与任何总额计算** —— 不可估值时保留它不等于承认其价值。
   */
  nativeValue?: number
  /** 不可估值 / 降级原因 */
  reasons: ValuationReason[]
  /** 资产类别，便于按类别汇总（取不到标的时为 undefined） */
  assetClass?: AssetClass
  /**
   * 参考值：例如「无可用行情，但有成本价」时的成本金额（原币）。
   * **仅供 UI 作为线索展示，绝不参与总额**。
   */
  fallbackValueInCurrency?: number
  /** 数据时间：行情或汇率的依据时间，便于展示「最后更新」 */
  asOf?: string
}

/* ------------------------------------------------------------------ *
 * 汇总结果（结构化，不是一个数字）
 * ------------------------------------------------------------------ */

/** 未可靠估值 / 降级的明细，供 UI 列出具体是哪几项 */
export interface UnvaluedItem {
  holdingId: string
  status: Extract<ValuationStatus, 'unavailable' | 'stale'>
  reasons: ValuationReason[]
  assetClass?: AssetClass
  currency: CurrencyCode
  /** 仅 stale 项可能有展示值（不计入总额） */
  displayValue?: number
}

export interface PortfolioTotals {
  /** 已可靠估值的资产合计（人民币）——**只包含 status === 'ok'** */
  totalAssets: number
  /** 已可靠估值的负债合计（人民币） */
  totalLiabilities: number
  /** 净资产 = totalAssets − totalLiabilities（同样只基于可靠估值） */
  netWorth: number

  /* ---- 以下三组让 UI 能区分「可靠 / 不可估值 / 过期」，而不是只拿到一个数字 ---- */

  /** ① 已可靠估值部分：按资产类别拆分 */
  reliableByAssetClass: Partial<Record<AssetClass, number>>
  /** 已可靠估值的资产条数 */
  reliableCount: number

  /** ② 不可估值的项目数与明细 */
  unavailableCount: number
  unavailableItems: UnvaluedItem[]

  /** ③ 估值依据已过期的项目数与明细（有展示值但不计入总额） */
  staleCount: number
  staleItems: UnvaluedItem[]

  /** 全部持仓数（便于 UI 显示「共 N 项，其中 M 项已可靠估值」） */
  totalHoldings: number

  /**
   * 汇总是否完整：`unavailableCount === 0 && staleCount === 0`。
   * false 时 UI **必须**提示「部分资产暂无法估值」，不能只显示总额。
   */
  isComplete: boolean
}

export function createEmptyTotals(): PortfolioTotals {
  return {
    totalAssets: 0,
    totalLiabilities: 0,
    netWorth: 0,
    reliableByAssetClass: {},
    reliableCount: 0,
    unavailableCount: 0,
    unavailableItems: [],
    staleCount: 0,
    staleItems: [],
    totalHoldings: 0,
    isComplete: true,
  }
}
