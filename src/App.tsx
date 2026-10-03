import { useCallback, useMemo, useState } from 'react'
import { Download, Plus, RotateCcw, ShieldCheck, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react'
import type { AssetItem, Category } from './types/asset'
import { usePortfolio } from './hooks/usePortfolio'
import { isFund, valuate } from './lib/calc'
import { exportPortfolio } from './lib/storage'
import { formatCNY, formatRate, formatRelative, formatSigned } from './lib/format'
import Header from './components/Header'
import CategoryCard from './components/CategoryCard'
import DetailSheet from './components/DetailSheet'
import CategoryForm from './components/CategoryForm'
import ConfirmDialog from './components/ConfirmDialog'
import StrategyCard from './components/StrategyCard'
import StrategySettingsSheet from './components/StrategySettingsSheet'
import Toast, { type ToastMessage, type ToastTone } from './components/Toast'
import { useStrategy } from './hooks/useStrategy'
import { categoryTotal } from './lib/calc'
import { statusLine } from './lib/rebalance'

// 键名沿用项目早期的 asset-card-wallet，改名 WealthCard 后刻意保持不变：
// 换键名会让老用户已保存的数据「凭空消失」。
const HIDE_KEY = 'asset-card-wallet/hideAmounts'

export default function App() {
  const {
    portfolio,
    summary,
    fundCodes,
    sync,
    storageError,
    recovered,
    dismissRecovered,
    syncQuotes,
    addCategory,
    updateCategory,
    removeCategory,
    moveCategory,
    addItem,
    updateItem,
    removeItem,
    resetAll,
    importPortfolio,
  } = usePortfolio()

  /** 策略与再平衡（纯前端计算，配置单独持久化） */
  const strategyState = useStrategy(portfolio)
  const {
    settings: strategySettings,
    strategy,
    result: rebalance,
    mapping,
    defaultMapping,
  } = strategyState

  const [strategySheetOpen, setStrategySheetOpen] = useState(false)
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null)
  const [categoryForm, setCategoryForm] = useState<{ open: boolean; initial?: Category | null }>({ open: false })
  const [confirmReset, setConfirmReset] = useState(false)
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem(HIDE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [toast, setToast] = useState<ToastMessage | null>(null)

  const notify = useCallback((text: string, tone: ToastTone = 'info') => {
    setToast({ id: Date.now(), text, tone })
  }, [])

  const categoryValues = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of portfolio.categories) out[c.id] = categoryTotal(c)
    return out
  }, [portfolio])

  const openCategory = useMemo(
    () => portfolio.categories.find((c) => c.id === openCategoryId) ?? null,
    [portfolio.categories, openCategoryId],
  )

  /* ---------------- 组合层统计 ---------------- */
  const stats = useMemo(() => {
    let profit = 0
    let cost = 0
    let items = 0
    for (const c of portfolio.categories) {
      for (const item of c.items) {
        items += 1
        if (!isFund(item)) continue
        const v = valuate(item)
        profit += v.profit ?? 0
        cost += v.cost ?? 0
      }
    }
    return { profit, cost, items, rate: cost > 0 ? profit / cost : 0 }
  }, [portfolio])

  /* ---------------- 事件 ---------------- */
  const toggleHidden = () => {
    setHidden((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(HIDE_KEY, next ? '1' : '0')
      } catch {
        /* 忽略 */
      }
      return next
    })
  }

  const handleRefresh = useCallback(async () => {
    if (fundCodes.length === 0) {
      notify('还没有基金持仓，先添加一只有基金代码的持仓吧', 'info')
      return
    }
    await syncQuotes(fundCodes)
    if (sync.lastError) return // 错误由 header 呈现
    notify('基金估值已更新', 'success')
  }, [fundCodes, notify, sync.lastError, syncQuotes])

  const handleExport = () => {
    const blob = new Blob([exportPortfolio(portfolio)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `WealthCard-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    notify('已导出本地数据 JSON', 'success')
  }

  const handleImport = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        const categories = Array.isArray(parsed?.categories) ? (parsed.categories as Category[]) : null
        if (!categories) throw new Error('缺少 categories 字段')
        importPortfolio({ ...parsed, categories })
        notify(`已导入 ${categories.length} 个分类`, 'success')
      } catch (e) {
        notify(e instanceof Error ? `导入失败：${e.message}` : '导入失败', 'error')
      }
    }
    reader.readAsText(file)
  }

  const handleAddItem = (categoryId: string, item: AssetItem) => {
    addItem(categoryId, item)
    notify('已保存到本地', 'success')
  }

  const handleCategorySubmit = (
    patch: Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'isLiability'>,
  ) => {
    if (categoryForm.initial) {
      updateCategory(categoryForm.initial.id, patch)
      notify('分类已更新', 'success')
    } else {
      addCategory(patch)
      notify('分类已创建', 'success')
    }
    setCategoryForm({ open: false })
  }

  const settingsOpen = categoryForm.open && !categoryForm.initial

  return (
    <div className="min-h-screen bg-black">
      <div className="mx-auto w-full max-w-[480px] px-4 pb-16">
        {storageError ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-300">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>{storageError}</span>
          </div>
        ) : null}

        {recovered ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.04] px-3.5 py-2.5 text-[12px] text-zinc-300">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <span className="flex-1">
              检测到本地数据缺失或损坏，已恢复为默认分类。
            </span>
            <button type="button" className="shrink-0 text-zinc-500 underline" onClick={dismissRecovered}>
              知道了
            </button>
          </div>
        ) : null}

        <Header
          summary={summary}
          history={portfolio.history}
          syncing={sync.loading}
          lastSuccessAt={sync.lastSuccessAt}
          syncError={sync.lastError}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          onRefresh={() => void handleRefresh()}
          strategyStatus={{ text: statusLine(rebalance), level: rebalance.health }}
        />

        {/* 分区标题 */}
        <div className="mt-7 flex items-end justify-between px-1">
          <div>
            <h2 className="text-[13px] font-medium text-zinc-300">资产分类</h2>
            <p className="mt-0.5 text-[11px] text-zinc-600">
              {portfolio.categories.length} 个分类 · {stats.items} 条记录
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCategoryForm({ open: true, initial: null })}
            className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/[0.08] active:scale-95"
          >
            <Plus size={13} /> 新分类
          </button>
        </div>

        {/* 卡片列表 */}
        <div className="mt-3 space-y-2.5">
          {portfolio.categories.map((category) => (
            <CategoryCard
              key={category.id}
              category={category}
              hidden={hidden}
              onOpen={(c) => setOpenCategoryId(c.id)}
            />
          ))}

          {portfolio.categories.length === 0 ? (
            <div className="rounded-card border border-dashed border-white/[0.1] px-4 py-10 text-center">
              <p className="text-[13px] text-zinc-400">还没有任何资产分类</p>
              <button
                type="button"
                className="btn-primary mx-auto mt-3"
                onClick={() => setCategoryForm({ open: true, initial: null })}
              >
                <Plus size={15} /> 新建分类
              </button>
            </div>
          ) : null}
        </div>

        {/* 策略配置与再平衡建议 */}
        <div className="mt-4">
          <StrategyCard result={rebalance} hidden={hidden} onOpenSettings={() => setStrategySheetOpen(true)} />
        </div>

        {/* 基金持仓汇总 */}
        {stats.cost > 0 ? (
          <div className="mt-4 rounded-card border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-zinc-500">基金持仓总盈亏</span>
              <span
                className={`inline-flex items-center gap-1 text-[15px] font-semibold tabular-nums ${
                  stats.profit >= 0 ? 'text-up' : 'text-down'
                }`}
              >
                {stats.profit >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {hidden ? '••••' : `${formatSigned(stats.profit)} 元`}
              </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px]">
              <span className="text-zinc-600">成本合计 {hidden ? '••••' : `${formatCNY(stats.cost)} 元`}</span>
              <span className={stats.profit >= 0 ? 'text-up/80' : 'text-down/80'}>{formatRate(stats.rate)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-white/[0.05] pt-2 text-[11px] text-zinc-600">
              <span>{fundCodes.length} 只基金 · 数据来自天天基金公开接口</span>
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={sync.loading}
                className="text-zinc-400 underline-offset-2 hover:underline disabled:opacity-50"
              >
                {sync.loading ? '同步中…' : '立即刷新'}
              </button>
            </div>
            {sync.lastSuccessAt ? (
              <p className="mt-1 text-[11px] text-zinc-600">上次更新：{formatRelative(sync.lastSuccessAt)}</p>
            ) : null}
          </div>
        ) : null}

        {/* 数据管理 */}
        <div className="mt-6">
          <h2 className="px-1 text-[13px] font-medium text-zinc-300">数据管理</h2>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <button type="button" className="btn-ghost" onClick={handleExport}>
              <Download size={14} /> 导出 JSON
            </button>
            <label className="btn-ghost cursor-pointer">
              <ShieldCheck size={14} /> 导入 JSON
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleImport(file)
                  e.target.value = ''
                }}
              />
            </label>
            <button type="button" className="btn-danger col-span-2" onClick={() => setConfirmReset(true)}>
              <RotateCcw size={14} /> 清空全部数据
            </button>
          </div>
          <p className="mt-3 px-1 text-[11px] leading-relaxed text-zinc-600">
            纯前端应用：所有数据仅保存在本机浏览器的 localStorage，清除浏览器数据会同时清空记录，建议定期导出备份。
          </p>
        </div>
      </div>

      {/* 详情面板 */}
      <DetailSheet
        category={openCategory}
        index={portfolio.categories.findIndex((c) => c.id === openCategoryId)}
        total={portfolio.categories.length}
        syncing={sync.loading}
        onClose={() => setOpenCategoryId(null)}
        onAddItem={handleAddItem}
        onUpdateItem={(categoryId, item) => {
          updateItem(categoryId, item)
          notify('已保存修改', 'success')
        }}
        onRemoveItem={removeItem}
        onUpdateCategory={updateCategory}
        onRemoveCategory={removeCategory}
        onMoveCategory={moveCategory}
        onRefresh={() => void handleRefresh()}
        onEditCategory={(c) => setCategoryForm({ open: true, initial: c })}
      />

      {/* 新增/编辑分类 */}
      <CategoryForm
        open={categoryForm.open}
        initial={categoryForm.initial}
        onSubmit={handleCategorySubmit}
        onDelete={
          categoryForm.initial
            ? () => {
                removeCategory(categoryForm.initial!.id)
                setCategoryForm({ open: false })
                setOpenCategoryId(null)
                notify('分类已删除', 'success')
              }
            : undefined
        }
        onClose={() => setCategoryForm({ open: false })}
      />

      {/* 策略设置 */}
      <StrategySettingsSheet
        open={strategySheetOpen}
        settings={strategySettings}
        strategy={strategy}
        mapping={mapping}
        defaultMapping={defaultMapping}
        categories={portfolio.categories}
        categoryValues={categoryValues}
        onClose={() => setStrategySheetOpen(false)}
        onSelectStrategy={(id) => {
          strategyState.setActiveStrategy(id)
          notify('已切换策略', 'success')
        }}
        onThresholdChange={strategyState.setThreshold}
        onIncludeLiabilitiesChange={(v) => strategyState.setFlag('includeLiabilities', v)}
        onSetMapping={strategyState.setCategoryMapping}
        onResetMapping={() => {
          strategyState.resetMapping()
          notify('已恢复默认映射', 'success')
        }}
        onAddCustomStrategy={() => strategyState.addCustomStrategy()}
        onUpdateCustomStrategy={strategyState.updateCustomStrategy}
        onRemoveCustomStrategy={(id) => {
          strategyState.removeCustomStrategy(id)
          notify('已删除自定义策略', 'success')
        }}
      />

      {/* 清空确认 */}
      <ConfirmDialog
        open={confirmReset}
        title="清空全部数据？"
        description="所有分类与条目将被删除并恢复为默认分类，此操作不可撤销。"
        confirmText="清空"
        onConfirm={() => {
          resetAll()
          setConfirmReset(false)
          setOpenCategoryId(null)
          notify('已清空并恢复默认分类', 'success')
        }}
        onCancel={() => setConfirmReset(false)}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* 无障碍：面板打开时给出语义提示 */}
      {openCategory || settingsOpen ? <span className="sr-only">面板已打开，按 Esc 关闭</span> : null}
    </div>
  )
}
