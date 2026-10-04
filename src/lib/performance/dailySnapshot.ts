/**
 * 每日快照编排（Phase 8 / W2）
 *
 * ## 语义链（严格保持 Phase 4 已确定的规则）
 *
 * ```
 * 打开 App
 *   ↓
 * 今天已有 REAL 快照？
 *   ├─ 有 → 补齐 attempt = success（崩溃恢复），不做任何捕获
 *   └─ 无 → 今天已经尝试过？
 *            ├─ 尝试过（无论成败）→ 不再重试
 *            └─ 未尝试 → captureSnapshot()
 *                         ├─ 成功 → attempt = success
 *                         └─ 失败 → attempt = failed（当天不再重试）
 * ```
 *
 * ## 为什么需要 attempt 状态
 *
 * 「今天有没有快照」不足以保证「今天只尝试一次」：
 *
 * ```
 * 第 1 次启动：byDate(today) = none → captureSnapshot() → 失败
 * 第 2 次启动：byDate(today) = none → 又 captureSnapshot()   ← 违反约束
 * ```
 *
 * 因此必须**持久化**记录「今天是否已尝试过」。存在 `meta` 表里
 * （键值状态，**不是资产事实**），不为此新建表。
 *
 * ## attempt 与 captureKind 是两件事
 *
 * | 概念 | 位置 | 含义 |
 * | --- | --- | --- |
 * | `captureKind` | 快照记录内 | 这份快照**怎么来的**：REAL / BACKFILLED / ESTIMATED |
 * | `attempt` | meta 键值 | 今天**是否尝试过**捕获（不论成败） |
 *
 * `failed` 的尝试**不产生快照**，因此没有 `captureKind` 可言；
 * 二者描述的是不同问题，不可互相替代。
 *
 * ## 六条硬约束
 *
 * 1. 同一天最多一个 REAL 快照（依赖 `upsertForDate` 的 `date` 唯一索引）
 * 2. 不补历史（只捕获「今天」，绝不遍历过去日期）
 * 3. 不插值（缺失日期就是缺失）
 * 4. 失败不阻断 App 启动
 * 5. 当天失败不重复尝试
 * 6. 第二天允许重新尝试（键按日期区分）
 */

import type { Snapshot } from '../../types/portfolio2'
import type { PortfolioRepository } from '../db/repository'
import { type CaptureOptions, captureSnapshot } from '../performance/snapshot'

/** 尝试状态 */
export type SnapshotAttemptStatus = 'success' | 'failed'

export interface SnapshotAttempt {
  date: string
  attemptedAt: string
  status: SnapshotAttemptStatus
  error?: string
  /** 是否由「快照已存在、仅补记状态」产生（崩溃恢复路径） */
  recovered?: boolean
}

/** meta 表键前缀；按日期区分，天然支持「第二天重新尝试」 */
export const SNAPSHOT_ATTEMPT_PREFIX = 'snapshot-attempt/'

export function snapshotAttemptKey(date: string): string {
  return `${SNAPSHOT_ATTEMPT_PREFIX}${date}`
}

/** 保留最近 N 天的尝试记录，避免 meta 表无限增长 */
export const ATTEMPT_RETENTION_DAYS = 30

/* ------------------------------------------------------------------ *
 * 读取
 * ------------------------------------------------------------------ */

export async function readSnapshotAttempt(
  repo: PortfolioRepository,
  date: string,
): Promise<SnapshotAttempt | undefined> {
  return repo.metaKv.get<SnapshotAttempt>(snapshotAttemptKey(date))
}

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

export type DailySnapshotOutcome =
  /** 快照已存在，本次不做捕获 */
  | { action: 'already-captured'; date: string; snapshot: Snapshot; recoveredAttempt: boolean }
  /** 本次成功捕获 */
  | { action: 'captured'; date: string; snapshot: Snapshot }
  /** 今天已尝试过且失败，不再重试 */
  | { action: 'attempted-failed'; date: string; error?: string }
  /** 捕获失败（首次尝试），App 必须继续正常运行 */
  | { action: 'capture-failed'; date: string; error: string }

export interface DailySnapshotOptions extends CaptureOptions {
  /** 注入时钟便于测试 */
  now?: number
}

/* ------------------------------------------------------------------ *
 * 编排
 * ------------------------------------------------------------------ */

/**
 * 确保今天有一份 REAL 快照（幂等）。
 *
 * **本函数绝不抛出**：任何失败都转换为 `capture-failed` 结果，
 * 由调用方决定是否提示，但**不阻断应用启动**。
 */
export async function ensureDailySnapshot(
  repo: PortfolioRepository,
  options: DailySnapshotOptions = {},
): Promise<DailySnapshotOutcome> {
  const now = options.now ?? Date.now()
  const date = options.date ?? new Date(now).toISOString().slice(0, 10)
  const attemptedAt = new Date(now).toISOString()

  try {
    /* ---- 1) 已有当天快照：仅补记 attempt（崩溃恢复路径） ---- */
    const existing = await repo.snapshots.byDate(date)
    if (existing) {
      const prior = await readSnapshotAttempt(repo, date)
      // attempt 缺失或为 failed 时补 success —— 快照在，事实就是成功的
      if (!prior || prior.status !== 'success') {
        await repo.metaKv.set(snapshotAttemptKey(date), {
          date,
          attemptedAt,
          status: 'success',
          recovered: true,
        } satisfies SnapshotAttempt)
        return { action: 'already-captured', date, snapshot: existing, recoveredAttempt: true }
      }
      return { action: 'already-captured', date, snapshot: existing, recoveredAttempt: false }
    }

    /* ---- 2) 今天已经尝试过：不再重试 ---- */
    const prior = await readSnapshotAttempt(repo, date)
    if (prior) {
      return { action: 'attempted-failed', date, error: prior.error }
    }

    /* ---- 3) 首次尝试捕获 ---- */
    let snapshot: Snapshot
    try {
      const result = await captureSnapshot(repo, { ...options, date, now })
      snapshot = result.snapshot
    } catch (e) {
      const message = e instanceof Error ? e.message : '快照捕获失败'
      // 记录失败，确保当天不再重试
      await repo.metaKv.set(snapshotAttemptKey(date), {
        date,
        attemptedAt,
        status: 'failed',
        error: message,
      } satisfies SnapshotAttempt)
      return { action: 'capture-failed', date, error: message }
    }

    await repo.metaKv.set(snapshotAttemptKey(date), {
      date,
      attemptedAt,
      status: 'success',
    } satisfies SnapshotAttempt)

    await pruneOldAttempts(repo, date)
    return { action: 'captured', date, snapshot }
  } catch (e) {
    // 最后一道保险：编排本身也不抛出
    return {
      action: 'capture-failed',
      date,
      error: e instanceof Error ? e.message : '快照编排失败',
    }
  }
}

/* ------------------------------------------------------------------ *
 * 清理
 * ------------------------------------------------------------------ */

/** 删除超过保留期的尝试记录（按日期字符串比较，天然有序） */
export async function pruneOldAttempts(
  repo: PortfolioRepository,
  today: string,
  retentionDays = ATTEMPT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(`${today}T00:00:00.000Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays)
  const cutoffKey = cutoff.toISOString().slice(0, 10)

  const keys = await repo.metaKv.keysWithPrefix(SNAPSHOT_ATTEMPT_PREFIX)
  let removed = 0
  for (const key of keys) {
    const date = key.slice(SNAPSHOT_ATTEMPT_PREFIX.length)
    if (date < cutoffKey) {
      await repo.metaKv.remove(key)
      removed += 1
    }
  }
  return removed
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

/** 供 UI 展示的一句话状态 */
export function describeDailySnapshot(outcome: DailySnapshotOutcome): string {
  switch (outcome.action) {
    case 'captured':
      return '今日资产快照已记录'
    case 'already-captured':
      return outcome.recoveredAttempt ? '今日快照已存在（已补记状态）' : '今日快照已记录'
    case 'attempted-failed':
      return `今日快照未能生成：${outcome.error ?? '原因未知'}`
    case 'capture-failed':
      return `今日快照未能生成：${outcome.error}`
  }
}
