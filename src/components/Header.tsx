import { Eye, EyeOff, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import type { HistoryPoint } from '../types/asset'
import type { Summary } from '../types/asset'
import { formatCNY, formatCompactCNY, formatRelative, formatSigned } from '../lib/format'

interface HeaderProps {
  summary: Summary
  history: HistoryPoint[]
  syncing: boolean
  lastSuccessAt?: number
  syncError?: string
  hidden: boolean
  onToggleHidden: () => void
  onRefresh: () => void
  /** 组合状态小字：当前策略 · 偏离度 · 健康度 */
  strategyStatus?: {
    text: string
    level: 'healthy' | 'watch' | 'warning' | 'critical'
  }
}

/** 组合健康度对应的状态点配色 */
const STATUS_DOT: Record<'healthy' | 'watch' | 'warning' | 'critical', string> = {
  healthy: 'bg-emerald-400',
  watch: 'bg-lime-400',
  warning: 'bg-amber-400',
  critical: 'bg-red-400',
}

/**
 * 顶部净资产区域：
 * 「资产卡包」标题 → 「净资产 CNY」标签 → 大字号总额 → 变化提示 / 同步状态。
 */
export default function Header({
  summary,
  history,
  syncing,
  lastSuccessAt,
  syncError,
  hidden,
  onToggleHidden,
  onRefresh,
  strategyStatus,
}: HeaderProps) {
  const { netWorth, totalAssets, totalLiabilities } = summary

  // 取最近一条与今天不同的历史快照作为对比基准
  const last = history.length >= 2 ? history[history.length - 2] : undefined
  const diff = last ? netWorth - last.netWorth : 0
  const hasHistory = Boolean(last) && Math.abs(diff) > 0.005

  const masked = '••••••'

  return (
    <header className="px-1 pt-6">
      <div className="flex items-center justify-between">
        <h1 className="text-[22px] font-semibold tracking-tight text-zinc-100">WealthCard</h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleHidden}
            aria-label={hidden ? '显示金额' : '隐藏金额'}
            className="rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"
          >
            {hidden ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={syncing}
            aria-label="刷新基金估值"
            className="rounded-full p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshCw size={17} className={syncing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      <div className="mt-7">
        <p className="text-[12px] font-medium tracking-wide text-zinc-500">净资产 CNY</p>
        <div className="mt-1.5 flex items-baseline gap-1">
          {/*
            窄屏（<390px，如 iPhone SE）下 40px 的金额会换行，
            这里按屏幕宽度收敛字号，保证「千万级」金额也能单行显示。
          */}
          <span className="text-[34px] font-semibold leading-none tracking-tight text-zinc-50 tabular-nums min-[390px]:text-[40px]">
            {hidden ? masked : formatCNY(netWorth)}
          </span>
          <span className="text-[13px] text-zinc-500">元</span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
          {hidden ? (
            <span className="text-zinc-500">金额已隐藏</span>
          ) : hasHistory && last ? (
            <span
              className={`inline-flex items-center gap-1 font-medium ${
                diff > 0 ? 'text-up' : 'text-down'
              }`}
            >
              {diff > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {formatSigned(diff)} 较 {last.date}
            </span>
          ) : (
            <span className="text-zinc-500">暂无历史变化</span>
          )}
        </div>

        <p className="mt-1 text-[11px] text-zinc-600">
          总资产 {hidden ? masked : formatCompactCNY(totalAssets)} · 总负债 {hidden ? masked : formatCompactCNY(totalLiabilities)}
        </p>

        {strategyStatus ? (
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-zinc-500">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[strategyStatus.level]}`}
            />
            <span className="truncate">{strategyStatus.text}</span>
          </p>
        ) : null}
      </div>

      <div className="mt-3 flex min-h-[16px] items-center gap-2 text-[11px]">
        {syncing ? (
          <span className="text-zinc-500">正在同步基金估值…</span>
        ) : syncError ? (
          <span className="truncate text-red-400/90">估值同步失败：{syncError}</span>
        ) : lastSuccessAt ? (
          <span className="text-zinc-600">估值更新于 {formatRelative(lastSuccessAt)}</span>
        ) : (
          <span className="text-zinc-600">本地数据 · 仅保存在此浏览器</span>
        )}
      </div>
    </header>
  )
}
