import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { AssetItem, Category, HistoryPoint } from '../types/asset'
import { categoryTotal, isFund, valuate } from '../lib/calc'
import { formatCNY, formatNav, formatQty, formatRate, formatRelative, formatSigned } from '../lib/format'
import { resolveIcon } from '../lib/icons'
import Sheet from './Sheet'
import ItemForm from './ItemForm'
import ConfirmDialog from './ConfirmDialog'

interface DetailSheetProps {
  category: Category | null
  /** 分类在列表中的位置信息，用于排序按钮 */
  index?: number
  total?: number
  syncing?: boolean
  history?: HistoryPoint[]
  onClose: () => void
  onAddItem: (categoryId: string, item: AssetItem) => void
  onUpdateItem: (categoryId: string, item: AssetItem) => void
  onRemoveItem: (categoryId: string, itemId: string) => void
  onUpdateCategory: (id: string, patch: Partial<Omit<Category, 'items' | 'id'>>) => void
  onRemoveCategory: (id: string) => void
  onMoveCategory: (id: string, dir: -1 | 1) => void
  onRefresh: () => void
  onEditCategory: (category: Category) => void
}

type Mode = { view: 'list' } | { view: 'form'; initial?: AssetItem }

export default function DetailSheet({
  category,
  index = 0,
  total = 1,
  syncing,
  onClose,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
  onUpdateCategory,
  onRemoveCategory,
  onMoveCategory,
  onRefresh,
  onEditCategory,
}: DetailSheetProps) {
  const [mode, setMode] = useState<Mode>({ view: 'list' })
  const [pendingDelete, setPendingDelete] = useState<{ type: 'item'; item: AssetItem } | { type: 'category' } | null>(
    null,
  )

  useEffect(() => {
    setMode({ view: 'list' })
  }, [category?.id])

  if (!category) return null

  const Icon = resolveIcon(category.icon)
  const subtotal = categoryTotal(category)
  const displayTotal = category.isLiability ? -Math.abs(subtotal) : subtotal
  const hasFunds = category.items.some(isFund)

  const handleSubmit = (item: AssetItem) => {
    if (mode.view === 'form' && mode.initial) onUpdateItem(category.id, item)
    else onAddItem(category.id, item)
    setMode({ view: 'list' })
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    if (pendingDelete.type === 'category') {
      onRemoveCategory(category.id)
      setPendingDelete(null)
      onClose()
      return
    }
    onRemoveItem(category.id, pendingDelete.item.id)
    setPendingDelete(null)
    setMode({ view: 'list' })
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={mode.view === 'form' ? (mode.initial ? '编辑条目' : '新增条目') : category.name}
        subtitle={mode.view === 'form' ? category.name : category.subtitle}
        leading={
          mode.view === 'form' ? (
            <button
              type="button"
              onClick={() => setMode({ view: 'list' })}
              aria-label="返回列表"
              className="-ml-1 mt-0.5 rounded-full p-1.5 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
            >
              <ArrowLeft size={17} />
            </button>
          ) : (
            <span
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${category.color}26`, color: category.color }}
            >
              <Icon size={17} />
            </span>
          )
        }
        footer={
          mode.view === 'list' ? (
            <div className="flex items-center gap-2.5 pb-1">
              <button type="button" className="btn-primary flex-1" onClick={() => setMode({ view: 'form' })}>
                <Plus size={15} /> 添加条目
              </button>
              {hasFunds ? (
                <button type="button" className="btn-ghost px-3.5" onClick={onRefresh} disabled={syncing}>
                  <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />
                </button>
              ) : null}
              <button
                type="button"
                className="btn-ghost px-3.5"
                onClick={() => onEditCategory(category)}
                aria-label="编辑分类"
              >
                <Pencil size={15} />
              </button>
            </div>
          ) : undefined
        }
      >
        {mode.view === 'list' ? (
          <div className="space-y-4">
            {/* 分类小计 */}
            <div className="rounded-2xl border border-white/[0.07] bg-gradient-to-b from-white/[0.05] to-transparent px-4 py-3.5">
              <p className="text-[11px] text-zinc-500">{category.isLiability ? '负债合计' : '分类合计'}</p>
              <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums text-zinc-50">
                {formatCNY(displayTotal)}
                <span className="ml-1 text-[12px] font-normal text-zinc-500">元</span>
              </p>
              <p className="mt-2 text-[11px] text-zinc-600">
                共 {category.items.length} 条记录
                {hasFunds ? ' · 基金行情随刷新自动更新' : ''}
              </p>
            </div>

            {/* 条目列表 */}
            {category.items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/[0.08] px-4 py-8 text-center">
                <p className="text-[13px] text-zinc-500">还没有记录</p>
                <p className="mt-1 text-[11px] text-zinc-600">点击下方「添加条目」开始登记资产</p>
              </div>
            ) : (
              <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-2xl border border-white/[0.06]">
                {category.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onEdit={() => setMode({ view: 'form', initial: item })}
                    onDelete={() => setPendingDelete({ type: 'item', item })}
                  />
                ))}
              </ul>
            )}

            {/* 分类级操作 */}
            <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] px-3.5 py-3">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="btn-ghost px-3 py-2"
                  disabled={index === 0}
                  onClick={() => onMoveCategory(category.id, -1)}
                  aria-label="上移分类"
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="btn-ghost px-3 py-2"
                  disabled={index >= total - 1}
                  onClick={() => onMoveCategory(category.id, 1)}
                  aria-label="下移分类"
                >
                  <ArrowDown size={14} />
                </button>
                <span className="ml-1 text-[11px] text-zinc-600">调整卡片顺序</span>
              </div>
              <button type="button" className="btn-danger px-3 py-2 text-[13px]" onClick={() => setPendingDelete({ type: 'category' })}>
                <Trash2 size={14} /> 删除分类
              </button>
            </div>

            {category.isLiability ? (
              <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-white/[0.06] px-3.5 py-3">
                <span className="text-[13px] text-zinc-300">按负债计入净资产（扣减）</span>
                <input
                  type="checkbox"
                  checked={category.isLiability === true}
                  onChange={(e) => onUpdateCategory(category.id, { isLiability: e.target.checked })}
                  className="h-4 w-4 accent-red-500"
                />
              </label>
            ) : null}
          </div>
        ) : (
          <ItemForm
            category={category}
            initial={mode.initial}
            onSubmit={handleSubmit}
            onDelete={
              mode.initial
                ? () => setPendingDelete({ type: 'item', item: mode.initial as AssetItem })
                : undefined
            }
            onCancel={() => setMode({ view: 'list' })}
          />
        )}
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.type === 'category' ? `删除「${category.name}」？` : '删除该条目？'}
        description={
          pendingDelete?.type === 'category'
            ? `该分类及其下 ${category.items.length} 条记录将被永久删除，数据无法恢复。`
            : '删除后该条记录将不再计入净资产。'
        }
        confirmText="删除"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  )
}

/* ------------------------------------------------------------------ */

function ItemRow({ item, onEdit, onDelete }: { item: AssetItem; onEdit: () => void; onDelete: () => void }) {
  const v = valuate(item)
  const fund = isFund(item)
  const quote = fund ? item.quote : undefined
  const liveNav = quote?.estimatedNav ?? quote?.publishedNav

  return (
    <li className="bg-white/[0.015] transition hover:bg-white/[0.04]">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <p className="truncate text-[14px] text-zinc-100">{item.name || '未命名'}</p>
          <p className="mt-0.5 truncate text-[11.5px] text-zinc-500">
            {fund ? (
              <>
                {item.code} · {formatQty(item.shares)} 份 · 成本 {formatNav(item.costNav)}
                {liveNav !== undefined ? ` · 现价 ${formatNav(liveNav)}` : ''}
              </>
            ) : item.kind === 'gold' ? (
              <>
                {formatQty(item.grams)} 克 · {formatCNY(item.pricePerGram)} 元/克
              </>
            ) : (
              (item.note ?? '')
            )}
          </p>
        </button>

        <button type="button" onClick={onEdit} className="shrink-0 text-right">
          <p className="text-[14.5px] font-medium tabular-nums text-zinc-100">{formatCNY(v.value)}</p>
          {fund && v.profit !== undefined ? (
            <p className={`mt-0.5 text-[11.5px] tabular-nums ${v.profit >= 0 ? 'text-up' : 'text-down'}`}>
              {formatSigned(v.profit)}（{formatRate(v.profitRate)}）
            </p>
          ) : (
            <p className="mt-0.5 text-[11.5px] text-zinc-600">{quote ? `${formatRelative(quote.fetchedAt)}更新` : '元'}</p>
          )}
        </button>

        <button
          type="button"
          onClick={onDelete}
          aria-label="删除条目"
          className="shrink-0 rounded-full p-2 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-400"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </li>
  )
}
