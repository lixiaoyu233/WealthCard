/**
 * 交易写入编排（Phase 8 / W4）
 *
 * ## 为什么必须有这一层（Step 1 发现的 Domain 缺口）
 *
 * W4 需要让用户录入 9 种交易。若让每个表单各自编排写入，就会出现
 * **「写了交易但没重建缓存」「重建了但没对账」** 这类不一致 ——
 * 也就是用户明确警告的「在 UI 层打补丁」。
 *
 * 因此把唯一的写入路径收敛到这里：
 *
 * ```
 * UI → TransactionService.recordTransaction()
 *        ↓
 *      ① 参数校验（业务前置检查）
 *      ② 构造 Transaction
 *      ③ **在内存中试算**：追加后跑 deriveLedger
 *      ④ 校验交易语义（超卖 / 币种不一致 / 缺目标账户 …）
 *      ⑤ 校验账户与标的存在、无重复持仓
 *      ⑥ 校验持仓数量不为负
 *      ⑦ rebuildHoldingsFromTransactions()  ← 从 Ledger 重建缓存
 *      ⑧ reconcileHoldings()                ← 账实校验
 *      ⑨ 全部通过 → 一次性整体写入 IndexedDB
 *        ↓
 *      IndexedDB（唯一事实源）
 * ```
 *
 * **任何一步失败都返回 `{ ok: false }`，绝不写入任何数据。**
 * 不存在「交易写进去了但缓存是旧的」这种中间态。
 *
 * ## 为什么先试算再写入
 *
 * `deriveLedger` 对超卖只**记录 issue**、并把数量截断到 0（`Holding.quantity`
 * 的类型不允许负数）。如果直接落库，账本就被写成了一个不可能的状态。
 * 因此本层在**写入前**用试算结果判定，拒绝而不是静默截断。
 *
 * ## 与既有领域逻辑的关系
 *
 * 本层**不重新实现**任何金融计算：
 * - 效果推导 → `deriveLedger` / `deriveLedgerEffects`（Phase 3/5）
 * - 成本口径 → 移动加权平均（Phase 3）
 * - 缓存重建 → `rebuildHoldingsFromTransactions`（Phase 5）
 * - 账实校验 → `reconcileHoldings`（Phase 3/5）
 * - 外部现金流语义 → 由 `TransactionType` 决定（Phase 4）
 */

import type {
  AllocationProfile,
  Holding,
  Portfolio2,
  Transaction,
  TransactionType,
  CurrencyCode,
} from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type LedgerIssue, deriveLedger, positionKey } from '../ledger/derive'
import { detectDuplicateHoldings } from '../ledger/duplicates'
import { rebuildHoldingsFromTransactions } from '../ledger/rebuild'
import { reconcileHoldings } from '../ledger/reconcile'
import { TRANSACTION_SEMANTICS } from '../ledger/types'

/* ------------------------------------------------------------------ *
 * 精度
 * ------------------------------------------------------------------ */

/**
 * 金额/数量比较容差（人民币与原币数量共用）。
 *
 * 与项目既有约定一致（Phase 4/5 使用 0.01 级别的容差）。
 * **UI 层不得另创一套 rounding** —— 一律引用这里。
 */
export const TRANSACTION_TOLERANCE = 0.01

const EPS = 1e-8

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

export interface RecordTransactionInput {
  type: TransactionType
  accountId: string
  /** 投资标的（buy/sell/dividend/interest/adjustment 必填） */
  instrumentId?: string
  /** 资金腿现金标的（buy/sell/deposit/withdraw/dividend/interest/fee/exchange 用） */
  cashInstrumentId?: string
  /** 划转目标账户 */
  toAccountId?: string
  /** 部分划转数量 */
  transferQuantity?: number
  /** 换汇目标现金标的 */
  toCashInstrumentId?: string
  /** 金额（原币） */
  amount: number
  /** 数量（buy/sell/adjustment） */
  quantity?: number
  /** 手续费（原币） */
  fee?: number
  /** 币种 */
  currency: CurrencyCode
  /** 换汇到账金额 */
  toAmount?: number
  /** 换汇目标币种 */
  toCurrency?: CurrencyCode
  /** ISO 时间戳 */
  timestamp: string
  note?: string
  /** 可选：显式指定交易 id（测试用） */
  id?: string
}

export type RecordFailureCode =
  | 'unknown-type'
  | 'missing-account'
  | 'unknown-account'
  | 'missing-instrument'
  | 'unknown-instrument'
  | 'missing-cash-instrument'
  | 'missing-transfer-target'
  | 'unknown-transfer-target'
  | 'not-enough-holding'
  | 'negative-holding'
  | 'ledger-issue'
  | 'duplicate-holding'
  | 'reconcile-failed'
  | 'invalid-input'

export interface RecordFailure {
  ok: false
  code: RecordFailureCode
  /** 面向用户的可读说明 */
  message: string
  /** 原始领域问题（便于排查） */
  issues?: LedgerIssue[]
}

export interface RecordSuccess {
  ok: true
  transaction: Transaction
  /** 写入后的组合（已含重建的持仓缓存） */
  portfolio: Portfolio2
  /** 重建摘要 */
  rebuilt: { rebuiltCount: number; createdCount: number; preservedCount: number }
  /** 对账摘要 */
  reconcile: { ok: boolean; matchedCount: number; holdingCount: number }
}

export type RecordResult = RecordSuccess | RecordFailure

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */


let seq = 0
function nextId(type: string, now: string): string {
  seq += 1
  return `tx_${type}_${new Date(now).getTime()}_${seq}`
}

/**
 * 生成一笔交易（不做校验）。
 *
 * ## 划转的数量语义（重要）
 *
 * `transferQuantity` **未指定时领域层默认移动整仓**。
 * 因此必须显式决定：
 *
 * | 标的类型 | 数量来源 |
 * | --- | --- |
 * | 现金（quantity 即金额） | `transferQuantity = amount` |
 * | 其他数量口径 | 必须由调用方提供 `quantity` |
 *
 * 否则「从 A 划 20000 到 B」会变成「把 A 的全部余额都划到 B」。
 */
export function buildTransaction(input: RecordTransactionInput): Transaction {
  /*
   * 直接采用 `transferQuantity`。
   *
   * **不在这里猜数量**：现金「数量即金额」的判定需要 `Portfolio2`，
   * 由 `recordTransaction` 在读取组合后解析并写回（见其步骤 3）。
   * 保持本函数为纯构造器，便于测试与复用。
   */
  const tx: Transaction = {
    id: input.id ?? nextId(input.type, input.timestamp),
    accountId: input.accountId,
    instrumentId: input.instrumentId,
    cashInstrumentId: input.cashInstrumentId,
    toAccountId: input.toAccountId,
    transferQuantity: input.transferQuantity,
    toCashInstrumentId: input.toCashInstrumentId,
    type: input.type,
    amount: input.amount,
    quantity: input.quantity,
    fee: input.fee,
    currency: input.currency,
    toAmount: input.toAmount,
    toCurrency: input.toCurrency,
    timestamp: input.timestamp,
    note: input.note,
  }
  return tx
}

/** 该交易是否要求指定标的（由语义表决定，避免各处硬编码） */
function requiresInstrument(type: TransactionType): boolean {
  return TRANSACTION_SEMANTICS[type].quantity !== 'none' || type === 'dividend' || type === 'interest'
}

/**
 * 该交易是否要求资金腿。
 *
 * ⚠️ `transfer` **不在其中**：划转的语义是「标的在账户间移动」
 * （由 `toAccountId` 驱动），不需要也不应该有资金腿 ——
 * 若同时提供 `cashInstrumentId === instrumentId`，
 * 领域层会报 `cash_leg_same_as_instrument` 而拒绝。
 */
function requiresCashLeg(type: TransactionType): boolean {
  return (
    type === 'buy' ||
    type === 'sell' ||
    type === 'deposit' ||
    type === 'withdraw' ||
    type === 'fee' ||
    type === 'exchange'
  )
}

/* ------------------------------------------------------------------ *
 * 前置校验（不依赖试算）
 * ------------------------------------------------------------------ */

export function validateTransactionInput(
  input: RecordTransactionInput,
  portfolio: Portfolio2,
): RecordFailure | null {
  const fail = (code: RecordFailureCode, message: string): RecordFailure => ({ ok: false, code, message })

  const semantic = TRANSACTION_SEMANTICS[input.type]
  if (!semantic) return fail('unknown-type', `未知的交易类型：${input.type}`)

  /* ---- 账户 ---- */
  if (!input.accountId) return fail('missing-account', '请选择账户')
  if (!portfolio.accounts.some((a) => a.id === input.accountId)) {
    return fail('unknown-account', '所选账户不存在（不会临时创建假账户）')
  }

  /* ---- 标的 ---- */
  if (requiresInstrument(input.type)) {
    if (!input.instrumentId) return fail('missing-instrument', '请选择标的')
    if (!portfolio.instruments.some((i) => i.id === input.instrumentId)) {
      return fail('unknown-instrument', '所选标的不存在（不会用字符串伪造持仓）')
    }
  } else if (input.instrumentId && !portfolio.instruments.some((i) => i.id === input.instrumentId)) {
    return fail('unknown-instrument', '所选标的不存在')
  }

  /*
   * 利息 / 分红：资金腿是可选的。
   *
   * - 标的**不是**现金（例如债券利息）→ 需要资金腿，收钱进现金账户；
   * - 标的**就是**现金（例如活期利息）→ **不要**资金腿，
   *   否则同一标的会同时产生投资腿与现金腿，被领域层拒绝
   *   （`cash_leg_same_as_instrument`）。
   */
  if (
    (input.type === 'dividend' || input.type === 'interest') &&
    input.cashInstrumentId &&
    input.cashInstrumentId === input.instrumentId
  ) {
    return fail(
      'invalid-input',
      '利息 / 分红的标的与资金腿不能是同一个标的；若收益来自该现金本身，请不要选择「资金来源」',
    )
  }

  /* ---- 资金腿 ---- */
  if (requiresCashLeg(input.type)) {
    if (!input.cashInstrumentId) {
      return fail('missing-cash-instrument', '请选择资金所在的现金账户')
    }
    if (!portfolio.instruments.some((i) => i.id === input.cashInstrumentId)) {
      return fail('missing-cash-instrument', '所选现金标的不存在')
    }
    // 单笔交易只有一种币种：交易币种必须与资金腿币种一致
    const cashInst = portfolio.instruments.find((i) => i.id === input.cashInstrumentId)!
    if (cashInst.currency !== input.currency && input.type !== 'exchange') {
      return fail(
        'invalid-input',
        `交易币种 ${input.currency} 与现金标的币种 ${cashInst.currency} 不一致；跨币种请先做一次换汇`,
      )
    }
  }

  /* ---- 划转目标 ---- */
  if (input.type === 'transfer') {
    if (!input.toAccountId) return fail('missing-transfer-target', '请选择目标账户')
    if (input.toAccountId === input.accountId) {
      return fail('missing-transfer-target', '源账户与目标账户不能相同')
    }
    if (!portfolio.accounts.some((a) => a.id === input.toAccountId)) {
      return fail('unknown-transfer-target', '目标账户不存在')
    }
  }

  /* ---- 金额 / 数量 ---- */
  if (!Number.isFinite(input.amount)) return fail('invalid-input', '金额无效')
  if (input.type !== 'transfer' && input.amount < 0) {
    return fail('invalid-input', '金额不能为负（负债请在负债账户中记录）')
  }
  if ((input.type === 'buy' || input.type === 'sell') && !(Number(input.quantity) > 0)) {
    return fail('invalid-input', '数量必须大于 0')
  }
  if (input.type === 'exchange') {
    if (!input.toCashInstrumentId) return fail('missing-cash-instrument', '请选择换入的现金标的')
    if (!portfolio.instruments.some((i) => i.id === input.toCashInstrumentId)) {
      return fail('missing-cash-instrument', '换入的现金标的不存在')
    }
    if (input.toCashInstrumentId === input.cashInstrumentId) {
      return fail('invalid-input', '换出与换入的现金标的不能相同')
    }
    if (!(Number(input.toAmount) > 0)) return fail('invalid-input', '请填写换汇到账金额')
  }
  if (!input.timestamp) return fail('invalid-input', '缺少交易日期')

  return null
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export interface RecordContext {
  /** 注入时钟便于测试；缺省真实时间 */
  now?: () => Date
}

/**
 * 记录一笔交易。
 *
 * **要么整体成功、要么什么都不写。** 详见文件头的数据流说明。
 */
export async function recordTransaction(
  repo: PortfolioRepository,
  input: RecordTransactionInput,
  context: RecordContext = {},
): Promise<RecordResult> {
  const now = context.now ?? (() => new Date())

  /* ---- 1) 读取当前事实 ---- */
  const portfolio = await repo.loadPortfolio()

  /* ---- 2) 前置校验 ---- */
  const invalid = validateTransactionInput(input, portfolio)
  if (invalid) return invalid

  /* ---- 3) 解析划转数量，再构造交易并**在内存中试算** ---- */
  const resolved: RecordTransactionInput = { ...input }
  if (resolved.type === 'transfer' && resolved.transferQuantity === undefined && resolved.quantity === undefined) {
    const inst = portfolio.instruments.find((i) => i.id === resolved.instrumentId)
    if (inst?.instrumentType === 'cash') {
      // 现金：数量即金额
      resolved.transferQuantity = resolved.amount
    } else {
      return {
        ok: false,
        code: 'invalid-input',
        message: '划转非现金标的时必须填写划转数量（否则会被理解为整体移仓）',
      }
    }
  }

  const tx = buildTransaction(resolved)
  const withTx: Portfolio2 = { ...portfolio, transactions: [...portfolio.transactions, tx] }

  const instrumentCurrency = (id: string) =>
    portfolio.instruments.find((i) => i.id === id)?.currency
  const isConfirmedCash = (id: string) => {
    const inst = portfolio.instruments.find((i) => i.id === id)
    return !!inst && inst.instrumentType === 'cash' && inst.classificationStatus === 'confirmed'
  }

  const trial = deriveLedger(withTx.transactions, { instrumentCurrency, isConfirmedCash })

  /* ---- 4) 交易语义校验：领域层报告的 issue 一律拒绝 ---- */
  const blocking = trial.issues.filter((i) => i.transactionId === tx.id)
  if (blocking.length > 0) {
    // 超卖单独给出更友好的提示
    const oversell = blocking.find((i) => i.reason === 'sell_exceeds_holding')
    if (oversell) {
      return {
        ok: false,
        code: 'not-enough-holding',
        message: `可卖数量不足：${oversell.detail}`,
        issues: blocking,
      }
    }
    return {
      ok: false,
      code: 'ledger-issue',
      message: blocking[0].detail,
      issues: blocking,
    }
  }

  /* ---- 5) 数量不得为负（防御性：类型上不允许，但不能静默） ---- */
  for (const pos of trial.positions.values()) {
    if (pos.quantity < -EPS || pos.costBasis < -EPS) {
      return {
        ok: false,
        code: 'negative-holding',
        message:
          `交易会导致「${pos.instrumentId}」出现负数持仓或负成本` +
          `（数量 ${pos.quantity}，成本 ${pos.costBasis}），已拒绝`,
      }
    }
  }

  /* ---- 6) 重复持仓：拒绝在脏数据上继续叠加 ---- */
  const dup = detectDuplicateHoldings(withTx)
  if (!dup.ok) {
    return { ok: false, code: 'duplicate-holding', message: dup.summary }
  }

  /* ---- 7) 从 Ledger 重建持仓缓存 ---- */
  const rebuilt = rebuildHoldingsFromTransactions(withTx)
  if (rebuilt.blocked) {
    return {
      ok: false,
      code: 'duplicate-holding',
      message: rebuilt.duplicateReport?.summary ?? '重建被阻断：存在重复持仓',
    }
  }
  const next: Portfolio2 = { ...withTx, holdings: rebuilt.holdings }

  /* ---- 8) 账实校验 ---- */
  const rec = reconcileHoldings(next)
  if (!rec.ok) {
    return {
      ok: false,
      code: 'reconcile-failed',
      message: `账实校验未通过（${rec.issues.length} 项）：${rec.issues[0]?.detail ?? ''}`,
    }
  }

  /* ---- 9) 全部通过：整体写入 ---- */
  await repo.replaceAll(next)
  void now

  return {
    ok: true,
    transaction: tx,
    portfolio: next,
    rebuilt: {
      rebuiltCount: rebuilt.rebuiltCount,
      createdCount: rebuilt.createdCount,
      preservedCount: rebuilt.preservedCount,
    },
    reconcile: { ok: rec.ok, matchedCount: rec.matchedCount, holdingCount: rec.holdingCount },
  }
}

/* ------------------------------------------------------------------ *
 * 查询辅助（供交易历史 UI）
 * ------------------------------------------------------------------ */

export interface TransactionQuery {
  accountId?: string
  instrumentId?: string
  type?: TransactionType
  currency?: CurrencyCode
  /** 起始日期（含），YYYY-MM-DD */
  from?: string
  /** 结束日期（含），YYYY-MM-DD */
  to?: string
}

/**
 * 按条件筛选交易（纯函数，**只筛选不计算**）。
 *
 * 金额与效果由 `deriveLedger` 提供，本函数不做任何金融计算。
 */
export function queryTransactions(
  transactions: Transaction[],
  query: TransactionQuery = {},
): Transaction[] {
  return transactions
    .filter((t) => (query.accountId ? t.accountId === query.accountId : true))
    .filter((t) => (query.instrumentId ? t.instrumentId === query.instrumentId : true))
    .filter((t) => (query.type ? t.type === query.type : true))
    .filter((t) => (query.currency ? t.currency === query.currency : true))
    .filter((t) => (query.from ? t.timestamp.slice(0, 10) >= query.from : true))
    .filter((t) => (query.to ? t.timestamp.slice(0, 10) <= query.to : true))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp)) // 默认最新在前
}

/* ------------------------------------------------------------------ *
 * 可用持仓（供卖出表单限制可卖数量）
 * ------------------------------------------------------------------ */

export interface AvailablePosition {
  accountId: string
  instrumentId: string
  quantity: number
  costBasis: number
  averageCost: number
}

/**
 * 计算某账户下所有可卖持仓（由 Ledger 推导，**不读 Holding 缓存**）。
 *
 * 卖出表单用这个结果限制可卖数量，避免提交后才被拒绝。
 */
export function availablePositions(portfolio: Portfolio2): AvailablePosition[] {
  const instrumentCurrency = (id: string) =>
    portfolio.instruments.find((i) => i.id === id)?.currency
  const ledger = deriveLedger(portfolio.transactions, { instrumentCurrency })

  const out: AvailablePosition[] = []
  for (const [key, pos] of ledger.positions) {
    if (pos.quantity <= EPS) continue
    const [accountId, instrumentId] = key.split('::')
    out.push({
      accountId,
      instrumentId,
      quantity: pos.quantity,
      costBasis: pos.costBasis,
      averageCost: pos.averageCost,
    })
  }
  return out
}

/** 某账户某标的的可卖数量 */
export function availableQuantity(
  portfolio: Portfolio2,
  accountId: string,
  instrumentId: string,
): number {
  const instrumentCurrency = (id: string) =>
    portfolio.instruments.find((i) => i.id === id)?.currency
  const ledger = deriveLedger(portfolio.transactions, { instrumentCurrency })
  return ledger.positions.get(positionKey(accountId, instrumentId))?.quantity ?? 0
}

/* ------------------------------------------------------------------ *
 * 供 UI 展示的持仓类型收窄
 * ------------------------------------------------------------------ */

/** 现金类标的（estimating 用），与估值引擎的口径一致：只看 instrumentType */
export function cashInstruments(portfolio: Portfolio2) {
  return portfolio.instruments.filter(
    (i) => i.instrumentType === 'cash' && i.classificationStatus === 'confirmed',
  )
}

export type { AllocationProfile, Holding }
