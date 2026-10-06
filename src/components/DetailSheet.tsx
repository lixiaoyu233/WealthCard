import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowDown, ArrowUp, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import type { AssetItem, Category, HistoryPoint } from '../types/asset'
import type { FxRates } from '../lib/currency'
import type { CashCandidate, FundingSource } from '../lib/settings'
import { categoryTotal, isFund, valuate } from '../lib/calc'
import { formatCNY, formatNav, formatQty, formatRate, formatRelative, formatSigned, moneyDisplay } from '../lib/format'
import { resolveIcon } from '../lib/icons'
import Sheet from './Sheet'
import ItemForm from './ItemForm'
import ConfirmDialog from './ConfirmDialog'
import { INTERVAL_LABEL, planForItem, type InstallmentPlan } from '../lib/installments'

interface DetailSheetProps {
  category: Category | null
  /** 分类在列表中的位置信息，用于排序按钮 */
  index?: number
  total?: number
  syncing?: boolean
  history?: HistoryPoint[]
  /** 汇率：外币条目折算用 */
  rates?: FxRates | null
  /** 可作为资金划拨来源的项目 */
  cashCandidates?: CashCandidate[]
  /** 基金申购默认方式 */
  fundDefault?: { useFunding: boolean; lastFundingSource?: FundingSource }
  onRememberFunding?: (source: FundingSource | undefined) => void
  /** 带划拨的新增：基金 +X / 现金 −X */
  onAddFundedItem?: (
    categoryId: string,
    item: AssetItem,
    source: FundingSource,
    amount: number,
  ) => void
  onClose: () => void
  onAddItem: (categoryId: string, item: AssetItem) => void
  onUpdateItem: (categoryId: string, item: AssetItem) => void
  onRemoveItem: (categoryId: string, itemId: string) => void
  onUpdateCategory: (id: string, patch: Partial<Omit<Category, 'items' | 'id'>>) => void
  onRemoveCategory: (id: string) => void
  onMoveCategory: (id: string, dir: -1 | 1) => void
  onRefresh: () => void
  onEditCategory: (category: Category) => void
  /** 打开「批量导入持仓」（基金/股票分类才有） */
  onOpenImport?: () => void
  /** 条目当前的策略映射来源文案（如「自动·穿透」），显示在条目行上 */
  mappingLabelOf?: (item: AssetItem, category: Category) => string
  /** 打开单笔资产的映射设置 */
  onOpenMapping?: (item: AssetItem, category: Category) => void
  /** 定期划扣计划（按条目查） */
  plans?: InstallmentPlan[]
  /** 扣款账户候选（现金与固定资产，余额不限，可扣成负数） */
  depositTargets?: CashCandidate[]
  /** 保存/删除计划：enabled=false 表示关掉计划（条目保留） */
  onSavePlan?: (itemId: string, plan: InstallmentPlan | null, enabled: boolean) => void
  /** 确认扣一期 */
  onConfirmTerm?: (plan: InstallmentPlan) => void
  /** 忽略过期提醒 */
  onSkipReminder?: (plan: InstallmentPlan) => void
  /** 已到期未处理的期数 */
  dueCount?: (plan: InstallmentPlan) => number
}

type Mode = { view: 'list' } | { view: 'form'; initial?: AssetItem }

export default function DetailSheet({
  category,
  index = 0,
  total = 1,
  syncing,
  rates,
  cashCandidates,
  fundDefault,
  onRememberFunding,
  onAddFundedItem,
  onClose,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
  onUpdateCategory,
  onRemoveCategory,
  onMoveCategory,
  onRefresh,
  onOpenImport,
  mappingLabelOf,
  onOpenMapping,
  plans,
  depositTargets,
  onSavePlan,
  onConfirmTerm,
  onSkipReminder,
  dueCount,
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
  const subtotal = categoryTotal(category, rates)
  /** 条目对应的定期划扣计划 */
  const planOf = (itemId: string) => (plans ? planForItem(plans, itemId) : undefined)
  const displayTotal = category.isLiability ? -Math.abs(subtotal) : subtotal
  const hasFunds = category.items.some(isFund)
  /** 只按名字判断：空状态时分类里还没有任何条目，无法靠 item.kind 推断 */
  const isFundCategory = /基金/.test(category.name)

  const handleSubmit = (item: AssetItem) => {
    if (mode.view === 'form' && mode.initial) onUpdateItem(category.id, item)
    else onAddItem(category.id, item)
    setMode({ view: 'list' })
  }

  /** 从现金划拨买入：两处金额必须一起改，所以交给上层一次性处理 */
  const handleSubmitFunded = (item: AssetItem, source: FundingSource, amount: number) => {
    onAddFundedItem?.(category.id, item, source, amount)
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
              className="-ml-1 mt-0.5 rounded-full p-1.5 text-ink3 transition hover:bg-s3 hover:text-ink1"
            >
              <ArrowLeft size={17} />
            </button>
          ) : (
            <span
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{
                backgroundColor: category.colorName
                  ? `var(--accent-${category.colorName}-soft)`
                  : 'var(--s2)',
                color: category.color,
              }}
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
            <div className="rounded-2xl border border-line bg-gradient-to-b from-s2 to-transparent px-4 py-3.5">
              <p className="text-[11px] text-ink4">{category.isLiability ? '负债合计' : '分类合计'}</p>
              <p className="mt-1 text-[26px] font-semibold leading-none tabular-nums text-ink1">
                {formatCNY(displayTotal)}
                <span className="ml-1 text-[12px] font-normal text-ink4">元</span>
              </p>
              <p className="mt-2 text-[11px] text-ink4">
                共 {category.items.length} 条记录
                {hasFunds ? ' · 基金行情随刷新自动更新' : ''}
              </p>
            </div>

            {/* 条目列表 */}
            {category.items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line px-4 py-8 text-center">
                <p className="text-[13px] text-ink2">还没有记录</p>
                {isFundCategory ? (
                  <>
                    <p className="mt-2 text-[11.5px] leading-relaxed text-ink4">
                      点下方「添加条目」，填入 <span className="text-ink2">6 位基金代码</span>
                      （如 161725）与持有份额，
                      <br />
                      应用会自动同步净值并算出盈亏
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-[11px] text-ink4">点击下方「添加条目」开始登记资产</p>
                )}
              </div>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                {category.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    rates={rates}
                    plan={planOf(item.id)}
                    dueCount={dueCount}
                    onConfirmTerm={onConfirmTerm}
                    onSkipReminder={onSkipReminder}
                    mappingLabel={mappingLabelOf?.(item, category)}
                    onOpenMapping={onOpenMapping ? () => onOpenMapping(item, category) : undefined}
                    onEdit={() => setMode({ view: 'form', initial: item })}
                    onDelete={() => setPendingDelete({ type: 'item', item })}
                  />
                ))}
              </ul>
            )}

            {/* 批量导入：粘贴别的 AI 识别截图后的文字 */}
            {onOpenImport &&
            (category.defaultKind === 'fund' || category.items.some(isFund) || /基金|股票/.test(category.name)) ? (
              <button
                type="button"
                data-testid="open-holding-import"
                className="btn-ghost w-full py-2.5 text-[12.5px]"
                onClick={onOpenImport}
              >
                <Upload size={14} /> 批量导入（粘贴 AI 识别的文字）
              </button>
            ) : null}

            {/* 分类级操作 */}
            <div className="flex items-center justify-between rounded-2xl border border-line px-3.5 py-3">
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
                <span className="ml-1 text-[11px] text-ink4">调整卡片顺序</span>
              </div>
              <button type="button" className="btn-danger px-3 py-2 text-[13px]" onClick={() => setPendingDelete({ type: 'category' })}>
                <Trash2 size={14} /> 删除分类
              </button>
            </div>

            {category.isLiability ? (
              <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-line px-3.5 py-3">
                <span className="text-[13px] text-ink2">按负债计入净资产（扣减）</span>
                <input
                  type="checkbox"
                  checked={category.isLiability === true}
                  onChange={(e) => onUpdateCategory(category.id, { isLiability: e.target.checked })}
                  className="h-4 w-4 accent-brand"
                />
              </label>
            ) : null}
          </div>
        ) : (
          <ItemForm
            category={category}
            rates={rates}
            cashCandidates={cashCandidates}
            fundDefault={fundDefault}
            onRememberFunding={onRememberFunding}
            onSubmitFunded={onAddFundedItem ? handleSubmitFunded : undefined}
            initial={mode.initial}
            plan={mode.initial ? planOf(mode.initial.id) : undefined}
            depositTargets={depositTargets}
            onSubmitPlan={onSavePlan}
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

function ItemRow({
  item,
  rates,
  plan,
  dueCount,
  onConfirmTerm,
  onSkipReminder,
  mappingLabel,
  onOpenMapping,
  onEdit,
  onDelete,
}: {
  item: AssetItem
  rates?: FxRates | null
  plan?: InstallmentPlan
  dueCount?: (plan: InstallmentPlan) => number
  onConfirmTerm?: (plan: InstallmentPlan) => void
  onSkipReminder?: (plan: InstallmentPlan) => void
  mappingLabel?: string
  onOpenMapping?: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const due = plan ? (dueCount?.(plan) ?? 0) : 0
  const v = valuate(item, rates)
  const money = moneyDisplay(v.valueInCurrency, v.currency, v.value, v.missingRate)
  const fund = isFund(item)
  const quote = fund ? item.quote : undefined
  const liveNav = quote?.estimatedNav ?? quote?.publishedNav

  return (
    <li className="bg-s2 transition hover:bg-s2">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left">
          <p className="truncate text-[14px] text-ink1">{item.name || '未命名'}</p>
          <p className="mt-0.5 truncate text-[11.5px] text-ink4">
            {fund ? (
              <>
                {item.code} · {formatQty(item.shares)} 份 · 成本 {formatNav(item.costNav)}
                {liveNav !== undefined ? ` · 现价 ${formatNav(liveNav)}` : ''}
                {v.currency !== 'CNY' ? ` · ${v.currency}` : ''}
              </>
            ) : item.kind === 'gold' ? (
              <>
                {formatQty(item.grams)} 克 · {moneyDisplay(item.pricePerGram, v.currency, item.pricePerGram, false).primary}
                /克{v.currency !== 'CNY' ? ` · ${v.currency}` : ''}
              </>
            ) : (
              <>
                {v.currency !== 'CNY' ? `${v.currency} · ` : ''}
                {item.note ?? ''}
              </>
            )}
          </p>
        </button>

        <button type="button" onClick={onEdit} className="shrink-0 text-right">
          <p className="text-[14.5px] font-medium tabular-nums text-ink1">{money.primary}</p>
          {money.secondary ? (
            <p className={`mt-0.5 text-[10.5px] tabular-nums ${v.missingRate ? 'tone-warn' : 'text-ink4'}`}>
              {money.secondary}
            </p>
          ) : null}
          {fund && v.profit !== undefined ? (
            <p className={`mt-0.5 text-[11.5px] tabular-nums ${v.profit >= 0 ? 'text-up' : 'text-down'}`}>
              {formatSigned(v.profit)}（{formatRate(v.profitRate)}）
            </p>
          ) : (
            <p className="mt-0.5 text-[11.5px] text-ink4">{quote ? `${formatRelative(quote.fetchedAt)}更新` : '元'}</p>
          )}
        </button>

        <button
          type="button"
          onClick={onDelete}
          aria-label="删除条目"
          className="shrink-0 rounded-full p-2 text-ink4 transition hover:bg-danger/10 hover:tone-danger"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* 定期划扣：剩余期数 / 每期金额 / 到期提示与操作 */}
      {plan ? (
        <div className="border-t border-line px-3.5 py-2.5" data-testid={'plan-' + plan.itemId}>
          <div className="flex items-start justify-between gap-2 text-[11.5px]">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-ink3">
              {due > 0 ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger"
                  data-testid={'plan-dot-' + plan.itemId}
                />
              ) : null}
              <span className="truncate">
                {plan.name} · 剩余 {plan.remainingTerms} 期 · {INTERVAL_LABEL[plan.interval]}{' '}
                {formatCNY(plan.perTermAmount)} 元
              </span>
            </span>
            <span className={'shrink-0 text-right ' + (due > 0 ? 'tone-danger' : 'text-ink4')}>
              {due > 0
                ? '待确认还款（' + due + ' 期 · ' + formatCNY(due * plan.perTermAmount) + '）'
                : '下次 ' + plan.nextDueDate}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            {due > 0 ? (
              <>
                <button
                  type="button"
                  data-testid={'plan-confirm-' + plan.itemId}
                  className="btn-primary px-3 py-1.5 text-[12px]"
                  onClick={() => onConfirmTerm?.(plan)}
                >
                  确认扣款
                </button>
                <button
                  type="button"
                  data-testid={'plan-skip-' + plan.itemId}
                  className="btn-ghost px-3 py-1.5 text-[12px]"
                  onClick={() => onSkipReminder?.(plan)}
                >
                  忽略提醒
                </button>
              </>
            ) : null}
            <span className="ml-auto text-[11px] text-ink4">
              欠款 {formatCNY(plan.remainingAmount)} · 已扣 {plan.paidTerms} 期
              {plan.countFullAmount ? ' · 全额计入负债' : ' · 按每期计入负债'}
            </span>
          </div>
        </div>
      ) : null}

      {/* 策略映射：这笔资产按什么算进投资策略 */}
      {onOpenMapping ? (
        <div className="flex items-center gap-2 border-t border-line px-3.5 py-2 text-[11px]">
          <span className="text-ink4">策略映射</span>
          {mappingLabel ? (
            <span className="chip" data-testid={'item-mapping-label-' + item.id}>
              {mappingLabel}
            </span>
          ) : null}
          <button
            type="button"
            data-testid={'item-mapping-' + item.id}
            className="ml-auto text-ink3 underline-offset-2 hover:underline"
            onClick={onOpenMapping}
          >
            设置
          </button>
        </div>
      ) : null}
    </li>
  )
}
