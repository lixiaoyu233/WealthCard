/**
 * 历史配置趋势
 *
 * ## 数据来源
 *
 * 直接使用 Phase 4 已保存的 **`Snapshot.positions`**，不重算、不插值。
 * 这正是当初坚持保存持仓级明细的回报。
 *
 * ## 关键约束：绝不伪造历史分类
 *
 * `SnapshotPosition.assetClassAtCapture` 是 Schema V4 才引入的字段。
 * v3 存量快照**没有**它，且**不会被回填**（回填等于用今天的分类伪造历史）。
 *
 * 因此本模块严格遵守：
 *
 * | 情况 | 行为 |
 * | --- | --- |
 * | 快照有 `assetClassAtCapture` | 按**当时**的分类统计 |
 * | 快照缺少该字段 | **明确标记「历史分类数据不可用」**，不产出分类构成 |
 * | 区间内缺日期 | **不插值**，只用真实存在的快照 |
 *
 * 宁可历史图存在缺口，也不把今天确认的分类倒填到过去。
 *
 * ## 不影响金额
 *
 * 本模块只做**构成比例**统计；金额与可靠性完全沿用快照里已存的值，
 * 因此不会改变 Phase 4 的任何口径。
 */

import type { Snapshot } from '../../types/portfolio2'

const round2 = (n: number) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ *
 * 单点构成
 * ------------------------------------------------------------------ */

export type CompositionResult =
  | {
      ok: true
      date: string
      totalCny: number
      byClass: Record<string, number>
      byClassShare: Record<string, number>
      /** 该快照整体是否完整（无 stale / unavailable） */
      isComplete: boolean
    }
  | {
      ok: false
      date: string
      /** 明确的原因，UI 直接展示 */
      reason: string
      /** 缺口的具体条数，便于提示 */
      missingClassCount: number
      isComplete: boolean
    }

/**
 * 计算某份快照的资产类别构成。
 *
 * ⚠️ 若快照缺少 `assetClassAtCapture`，返回 `ok: false` 而**不是**退化成
 * 「用当前分类补上」—— 那会让历史趋势随分类确认而整体重画。
 */
export function compositionAtCapture(snapshot: Snapshot): CompositionResult {
  const totalCny = round2(snapshot.positions.filter((p) => p.reliable).reduce((s, p) => s + p.valueCny, 0))
  const isComplete = snapshot.isComplete ?? true

  if (snapshot.positions.length === 0) {
    return {
      ok: false,
      date: snapshot.date,
      reason: '该快照没有持仓明细，历史分类数据不可用',
      missingClassCount: 0,
      isComplete,
    }
  }

  const missing = snapshot.positions.filter((p) => p.assetClassAtCapture === undefined)
  if (missing.length > 0) {
    return {
      ok: false,
      date: snapshot.date,
      reason: `该快照有 ${missing.length} / ${snapshot.positions.length} 条持仓未记录当时的分类，历史分类数据不可用`,
      missingClassCount: missing.length,
      isComplete,
    }
  }

  const byClass: Record<string, number> = {}
  for (const p of snapshot.positions) {
    if (!p.reliable) continue
    const cls = p.assetClassAtCapture as string
    byClass[cls] = round2((byClass[cls] ?? 0) + p.valueCny)
  }

  const byClassShare: Record<string, number> = {}
  for (const [k, v] of Object.entries(byClass)) {
    byClassShare[k] = totalCny > 0 ? v / totalCny : 0
  }

  return { ok: true, date: snapshot.date, totalCny, byClass, byClassShare, isComplete }
}

/* ------------------------------------------------------------------ *
 * 趋势序列
 * ------------------------------------------------------------------ */

export interface TrendPoint {
  date: string
  /** 净资产（直接取快照值，不重算） */
  netWorth: number
  /** 是否有可用的历史分类 */
  hasClassification: boolean
  /** 无分类时的原因 */
  unavailableReason?: string
  byClass?: Record<string, number>
  byClassShare?: Record<string, number>
  /** 该点是否完整（不完整时 UI 必须显式标注） */
  isComplete: boolean
  /** 是否可用于展示（完整 + 有分类） */
  usable: boolean
}

export interface TrendSeries {
  points: TrendPoint[]
  /** 出现的全部类别（跨所有可用点），用于图例 */
  classes: string[]
  /** 有分类缺口的时间段 */
  gaps: Array<{ date: string; reason: string }>
  /** 一句话说明，可直接展示 */
  summary: string
}

/**
 * 构建历史配置趋势。
 *
 * @param snapshots 全部快照（任意顺序）；缺失日期**不会**被补齐
 * @param options.since 可选的起始日期（含）
 */
export function buildCompositionTrend(
  snapshots: Snapshot[],
  options: { since?: string; until?: string } = {},
): TrendSeries {
  const filtered = snapshots
    .filter((s) => (options.since ? s.date >= options.since : true))
    .filter((s) => (options.until ? s.date <= options.until : true))
    .sort((a, b) => a.date.localeCompare(b.date))

  const points: TrendPoint[] = []
  const gaps: TrendPoint['date'][] = []
  const gapDetails: Array<{ date: string; reason: string }> = []
  const classSet = new Set<string>()

  for (const snap of filtered) {
    const comp = compositionAtCapture(snap)
    if (comp.ok) {
      for (const k of Object.keys(comp.byClass)) classSet.add(k)
      points.push({
        date: snap.date,
        netWorth: snap.netWorth,
        hasClassification: true,
        byClass: comp.byClass,
        byClassShare: comp.byClassShare,
        isComplete: comp.isComplete,
        usable: comp.isComplete,
      })
    } else {
      gaps.push(snap.date)
      gapDetails.push({ date: snap.date, reason: comp.reason })
      points.push({
        date: snap.date,
        netWorth: snap.netWorth,
        hasClassification: false,
        unavailableReason: comp.reason,
        isComplete: comp.isComplete,
        usable: false,
      })
    }
  }

  const usableCount = points.filter((p) => p.usable).length
  const summary =
    points.length === 0
      ? '还没有历史快照，无法展示趋势'
      : gaps.length === 0
        ? `${points.length} 个历史时点，其中 ${usableCount} 个可用于构成趋势`
        : `${points.length} 个历史时点；${gaps.length} 个因未记录当时的分类而标记为「历史分类数据不可用」（不回填、不插值）`

  return {
    points,
    classes: [...classSet].sort(),
    gaps: gapDetails,
    summary,
  }
}

/* ------------------------------------------------------------------ *
 * 下钻：某个时点的明细
 * ------------------------------------------------------------------ */

/** 某份快照里按类别归组的持仓（仅在分类可用时） */
export function positionsByClass(
  snapshot: Snapshot,
): Array<{ assetClass: string; valueCny: number; instrumentId: string; accountId: string }> {
  return snapshot.positions
    .filter((p) => p.reliable && p.assetClassAtCapture !== undefined)
    .map((p) => ({
      assetClass: p.assetClassAtCapture as string,
      valueCny: p.valueCny,
      instrumentId: p.instrumentId,
      accountId: p.accountId,
    }))
}

/** 供 UI 提示：这些日期需要重新捕获快照才能获得分类趋势 */
export function datesNeedingRecapture(series: TrendSeries): string[] {
  return series.gaps.map((g) => g.date)
}
