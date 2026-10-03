import { ChevronRight, CreditCard, TrendingDown, TrendingUp } from 'lucide-react'
import type { Category } from '../types/asset'
import { categoryCountLabel, categoryTotal, isFund, valuate } from '../lib/calc'
import { formatCNY, formatRate } from '../lib/format'
import { resolveIcon } from '../lib/icons'

interface CategoryCardProps {
  category: Category
  hidden?: boolean
  onOpen: (category: Category) => void
}

/**
 * 资产分类卡片：左侧彩色半透明图标 + 名称 + 副标题，右侧金额 + 项数标签。
 * 基金分类额外展示持仓盈亏（红涨绿跌）。
 */
export default function CategoryCard({ category, hidden, onOpen }: CategoryCardProps) {
  const Icon = resolveIcon(category.icon)
  const total = categoryTotal(category)
  const count = categoryCountLabel(category)

  // 基金分类的持仓盈亏合计
  const fundStats = category.items.filter(isFund).reduce(
    (acc, item) => {
      const v = valuate(item)
      return { profit: acc.profit + (v.profit ?? 0), cost: acc.cost + (v.cost ?? 0) }
    },
    { profit: 0, cost: 0 },
  )
  const hasFunds = category.items.some(isFund)
  const profitRate = fundStats.cost > 0 ? fundStats.profit / fundStats.cost : 0
  const display = category.isLiability ? -Math.abs(total) : total

  return (
    <button
      type="button"
      onClick={() => onOpen(category)}
      className="card-surface group block w-full px-4 py-3.5 text-left transition duration-200 hover:border-white/[0.12] active:scale-[0.985]"
    >
      {/* 分类主题色的极淡径向光晕，保持暗黑质感的同时呼应图标颜色 */}
      <span
        aria-hidden
        className="pointer-events-none absolute -left-8 -top-10 h-28 w-28 rounded-full opacity-[0.14] blur-2xl"
        style={{ background: category.color }}
      />

      <div className="relative flex items-center gap-3.5">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px]"
          style={{ backgroundColor: `${category.color}26`, color: category.color }}
        >
          <Icon size={20} strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-zinc-100">{category.name}</p>
          <p className="mt-0.5 truncate text-[12px] text-zinc-500">{category.subtitle || '—'}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end">
          <span className="text-[16px] font-semibold tabular-nums text-zinc-100">
            {hidden ? '••••' : formatCNY(display)}
          </span>
          <span className="mt-1 inline-flex items-center gap-1.5">
            {category.isLiability ? <CreditCard size={11} className="text-red-400/70" /> : null}
            <span className="chip">{count}</span>
          </span>
        </div>

        <ChevronRight size={16} className="shrink-0 text-zinc-700 transition group-hover:text-zinc-500" />
      </div>

      {hasFunds ? (
        <div className="relative mt-2.5 flex items-center gap-1.5 border-t border-white/[0.05] pt-2.5 text-[11.5px]">
          {hidden ? (
            <span className="text-zinc-600">持仓盈亏已隐藏</span>
          ) : (
            <>
              <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${fundStats.profit >= 0 ? 'text-up' : 'text-down'}`}>
                {fundStats.profit >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {fundStats.profit >= 0 ? '+' : '-'}
                {formatCNY(Math.abs(fundStats.profit))}
              </span>
              <span className={fundStats.profit >= 0 ? 'text-up/80' : 'text-down/80'}>{formatRate(profitRate)}</span>
              <span className="text-zinc-600">持仓盈亏</span>
            </>
          )}
        </div>
      ) : null}
    </button>
  )
}
