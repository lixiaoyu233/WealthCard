import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Download, Minus, Plus, RotateCcw, ShieldCheck, TrendingDown, TrendingUp, TriangleAlert } from 'lucide-react'
import type { AssetItem, Category } from './types/asset'
import { makeFundItem, usePortfolio } from './hooks/usePortfolio'
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
import SettingsSheet, { type SettingsPage } from './components/SettingsSheet'
import DividendHomeCard from './components/DividendHomeCard'
import HoldingImportSheet from './components/HoldingImportSheet'
import ItemMappingSheet from './components/ItemMappingSheet'
import { itemKeyOf, mappingSourceLabel, resolveItemMapping } from './lib/itemMapping'
import { appendHoldings, type ParsedHolding } from './lib/holdingImport'
import { collectHoldingRefs } from './lib/calc'
import TrendsPanel from './components/TrendsPanel'
import Toast, { type ToastMessage, type ToastTone } from './components/Toast'
import { useStrategy } from './hooks/useStrategy'
import { useAssetMix } from './hooks/useAssetMix'
import { useTheme } from './hooks/useTheme'
import { useSettings } from './hooks/useSettings'
import { useDividends } from './hooks/useDividends'
import { useInstallments } from './hooks/useInstallments'
import { monthlyPressure } from './lib/installments'
import { formatMonth, listDepositTargets, type HomeBlockId } from './lib/settings'
import { strategyStatusFor } from './lib/homeLayout'
import { advanceSnapshot } from './lib/netWorthHistory'
import { resolveSafeTopInset } from './lib/safeArea'
import { categoryTotal } from './lib/calc'
import { statusLine } from './lib/rebalance'

// 键名沿用项目早期的 asset-card-wallet，改名 WealthCard 后刻意保持不变：
// 换键名会让老用户已保存的数据「凭空消失」。
const HIDE_KEY = 'asset-card-wallet/hideAmounts'

export default function App() {
  const {
    portfolio,
    summary,
    exposure,
    fx,
    fundCodes,
    sync,
    storageError,
    recovered,
    addedCategories,
    dismissRecovered,
    syncQuotes,
    addCategory,
    updateCategory,
    removeCategory,
    moveCategory,
    addItem,
    addFundedItem,
    updateItem,
    removeItem,
    resetAll,
    importPortfolio,
  } = usePortfolio()

  /** 主题：默认跟随系统，可手动切日间 / 夜间 */
  const { mode: themeMode, cycle: cycleTheme } = useTheme()

  /**
   * 设置：基金申购资金来源 + 薪资。
   * 薪资自动入账会改动资产，所以要把新的 portfolio 写回去。
   */
  const settingsState = useSettings(portfolio, (next) => importPortfolio(next))

  /** 穿透取数：中国上市基金/ETF 的资产占比（缓存 7 天），失败自动降级为名称推测 */
  const assetMix = useAssetMix(portfolio)

  /**
   * 分红：A股走东财自动抓取，其余市场手工录入。
   * 入账会改动持仓/现金，所以把新的组合写回 portfolio。
   */
  const dividendsState = useDividends(portfolio, (next) => importPortfolio(next), {
    rates: fx.rates,
    taxUs: settingsState.settings.dividends.usTaxRate,
    taxHk: settingsState.settings.dividends.hkTaxRate,
  })

  /** 定期划扣：计划挂在负债条目上，条目余额由计划维护；到期只提示、不自动扣 */
  const installmentsState = useInstallments(portfolio, (next) => importPortfolio(next))
  /** 扣款账户候选：现金与固定资产下的金额条目（余额不限，可以扣成负数） */
  const depositTargets = useMemo(() => listDepositTargets(portfolio), [portfolio])

  /** 策略与再平衡：把穿透占比与「分期划扣不计入配置」一起喂给计算 */
  const installmentItemIds = useMemo(() => installmentsState.plans.map((p) => p.itemId), [installmentsState.plans])
  const strategyState = useStrategy(portfolio, {
    autoMixOf: assetMix.autoMixOf,
    excludedItemIds: installmentItemIds,
  })

  /**
   * 总资产月度快照：数据一变就更新当月；每月第一次打开时把上月定稿。
   * 计算很轻（遍历一次分类），所以直接在 effect 里推进即可。
   */
  useEffect(() => {
    const advanced = advanceSnapshot(settingsState.snapshot, {
      portfolio,
      rates: fx.rates,
      // 口径与首页一致：是否计入负债由策略设置决定
      includeLiabilities: strategyState.settings.includeLiabilities,
    })
    if (advanced.changed) settingsState.setSnapshot(advanced.file)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio, fx.rates, strategyState.settings.includeLiabilities])
  const {
    settings: strategySettings,
    strategy,
    result: rebalance,
    mapping,
    defaultMapping,
  } = strategyState

  const [strategySheetOpen, setStrategySheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  /** 首页区块的「查看全部」可以直接落在设置里的某一页 */
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>(undefined)
  /** 批量导入持仓（基金 / 股票分类） */
  const [importOpen, setImportOpen] = useState(false)
  /** 单笔资产的映射设置目标 */
  const [mappingTarget, setMappingTarget] = useState<{ item: AssetItem; category: Category } | null>(null)
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
    for (const c of portfolio.categories) out[c.id] = categoryTotal(c, fx.rates)
    return out
  }, [portfolio, fx.rates])

  /**
   * 顶部安全区：首屏前内联脚本已设过一次，这里在挂载后按实际视口再校准一次。
   * 目的是覆盖「内联脚本读到 0、但实际需要避让」的情况。
   */
  useEffect(() => {
    resolveSafeTopInset()
    const onResize = () => resolveSafeTopInset()
    window.addEventListener('orientationchange', onResize)
    return () => window.removeEventListener('orientationchange', onResize)
  }, [])

  // 固定薪资自动入账提示（只提示一次）
  useEffect(() => {
    if (!settingsState.autoApplied) return
    const { month, amount, itemName } = settingsState.autoApplied
    notify(`固定薪资已入账：${formatMonth(month)} +${formatCNY(amount, 0)} 元 → ${itemName ?? '现金项目'}`, 'success')
    settingsState.dismissAutoApplied()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsState.autoApplied])

  // 版本升级提示：新增了内置分类（只提示一次）
  useEffect(() => {
    if (!addedCategories || addedCategories.length === 0) return
    notify(`已新增「${addedCategories.join('」「')}」分类，可直接使用`, 'info')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCategory = useMemo(
    () => portfolio.categories.find((c) => c.id === openCategoryId) ?? null,
    [portfolio.categories, openCategoryId],
  )

  /* ---------------- 组合层统计 ---------------- */
  const stats = useMemo(() => {
    let profit = 0
    let cost = 0
    let items = 0
    let holdings = 0
    for (const c of portfolio.categories) {
      for (const item of c.items) {
        items += 1
        if (!isFund(item)) continue
        holdings += 1
        const v = valuate(item)
        profit += v.profit ?? 0
        cost += v.cost ?? 0
      }
    }
    return { profit, cost, items, holdings, rate: cost > 0 ? profit / cost : 0 }
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
    // 顶部刷新按钮同时刷新汇率（有外币条目时才请求）
    if (fx.hasForeign) await fx.sync({ force: true, silent: true })
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

  /** 批量导入的落点：基金 → 基金分类，股票 → 股票分类 */
  const importTargets = useMemo(() => {
    const fund = portfolio.categories.find(
      (c) => c.id === 'cat_fund' || (/基金/.test(c.name) && !/股票/.test(c.name)),
    )
    const stock = portfolio.categories.find((c) => c.id === 'cat_stock' || /股票/.test(c.name))
    return { fund, stock }
  }, [portfolio.categories])
  /** 已有持仓（代码 + 市场），用于同代码重复检测 */
  const existingHoldings = useMemo(() => collectHoldingRefs(portfolio), [portfolio])

  /** 某笔资产当前按什么算进策略（穿透/名称/分类/未归类） */
  const mappingLabelOf = useCallback(
    (item: AssetItem, category: Category) => {
      const auto = assetMix.autoMixOf(item)
      const resolved = resolveItemMapping({
        item,
        category,
        strategy: strategyState.strategy,
        itemMapping: strategyState.itemMapping,
        categoryEntries: strategyState.mapping[category.id],
        autoMix: auto?.mix,
        autoMixOrigin: auto?.origin,
        excludedItemIds: installmentItemIds,
        bondTerm: item.bondTerm,
      })
      return mappingSourceLabel(resolved)
    },
    [assetMix, strategyState.strategy, strategyState.itemMapping, strategyState.mapping, installmentItemIds],
  )

  const handleHoldingImport = (rows: ParsedHolding[]) => {
    const entries = rows.map((h) => {
      const target = h.type === 'fund' ? importTargets.fund : importTargets.stock
      return {
        categoryId: target?.id ?? '',
        item: makeFundItem({
          name: h.name || h.code,
          code: h.code,
          market: h.market,
          shares: h.shares,
          costNav: h.costNav ?? 0,
          manualNav: h.price,
          note: h.note,
        }),
      }
    })
    const res = appendHoldings(portfolio, entries)
    if (res.added === 0) {
      notify('没有可导入的条目：目标分类不存在（先建一个「基金」或「股票」分类）', 'error')
      return
    }
    importPortfolio(res.portfolio)
    notify(`已导入 ${res.added} 条持仓${res.skipped > 0 ? `，${res.skipped} 条缺分类已跳过` : ''}`, 'success')
    setImportOpen(false)
  }

  const handleAddItem = (categoryId: string, item: AssetItem) => {
    addItem(categoryId, item)
    notify('已保存到本地', 'success')
  }

  const handleCategorySubmit = (
    patch: Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'colorName' | 'isLiability'>,
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

  /** 有持仓才用涨跌配色；0 持仓保持中性，避免出现「0 元却是绿色上涨」 */
  const hasHoldings = stats.holdings > 0

  /**
   * 首页中间区块。显示哪些、按什么顺序由设置 →「首页显示」决定；
   * 顶部净资产、资产分类固定在前面，数据管理固定在最后，不在这个集合里。
   */
  const homeBlocks: Record<HomeBlockId, ReactNode> = {
    holdingsProfit: (
      <div className="mt-4 rounded-card border border-line bg-s2 px-4 py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-ink4">持仓总盈亏</span>
          <span
            className={`inline-flex items-center gap-1 text-[15px] font-semibold tabular-nums ${
              hasHoldings ? (stats.profit >= 0 ? 'text-up' : 'text-down') : 'text-ink2'
            }`}
          >
            {hasHoldings ? (
              stats.profit >= 0 ? (
                <TrendingUp size={14} />
              ) : (
                <TrendingDown size={14} />
              )
            ) : (
              <Minus size={14} />
            )}
            {hidden ? '••••' : `${formatSigned(stats.profit)} 元`}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <span className="text-ink4">成本合计 {hidden ? '••••' : `${formatCNY(stats.cost)} 元`}</span>
          <span className={hasHoldings ? (stats.profit >= 0 ? 'text-up/80' : 'text-down/80') : 'text-ink4'}>
            {formatRate(stats.rate)}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[11px] text-ink4">
          <span>{stats.holdings} 只持仓 · 数据来自天天基金 / 腾讯公开接口</span>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={sync.loading}
            className="text-ink3 underline-offset-2 hover:underline disabled:opacity-50"
          >
            {sync.loading ? '同步中…' : '立即刷新'}
          </button>
        </div>
        {sync.lastSuccessAt ? (
          <p className="mt-1 text-[11px] text-ink4">上次更新：{formatRelative(sync.lastSuccessAt)}</p>
        ) : null}
      </div>
    ),
    strategy: (
      <div className="mt-4">
        <StrategyCard result={rebalance} hidden={hidden} onOpenSettings={() => setStrategySheetOpen(true)} />
      </div>
    ),
    trends: (
      <div className="mt-4">
        <TrendsPanel
          points={settingsState.snapshot.points}
          salaryRecords={settingsState.settings.salary.records}
          metrics={settingsState.settings.trends.metrics}
          defaultRange={settingsState.settings.trends.range}
          showLabels={settingsState.settings.trends.showLabels}
          showMom={settingsState.settings.trends.showMom}
          colorByTrend={settingsState.settings.trends.colorByTrend}
        />
      </div>
    ),
    dividends: (
      <div className="mt-4">
        <DividendHomeCard
          portfolio={portfolio}
          dividends={dividendsState}
          rates={fx.rates}
          dividendSettings={settingsState.settings.dividends}
          notify={notify}
          onOpenAll={() => {
            setSettingsPage('dividends')
            setSettingsSheetOpen(true)
          }}
          onNeedCashAccount={() => {
            setSettingsPage('dividends')
            setSettingsSheetOpen(true)
          }}
        />
      </div>
    ),
  }

  /**
   * 策略表单的数据与回调。
   * 首页策略卡片的齿轮弹层、设置里的「投资策略」页共用同一份，
   * 避免两处行为漂移（改一处、漏一处）。
   */
  const strategyFormProps = {
    settings: strategySettings,
    strategy,
    mapping,
    categories: portfolio.categories,
    categoryValues,
    onSelectStrategy: (id: string) => {
      strategyState.setActiveStrategy(id)
      notify('已切换策略', 'success')
    },
    onThresholdChange: strategyState.setThreshold,
    onIncludeLiabilitiesChange: (v: boolean) => strategyState.setFlag('includeLiabilities', v),
    onSetMapping: strategyState.setCategoryMapping,
    onResetMapping: () => {
      strategyState.resetMapping()
      notify('已恢复默认映射', 'success')
    },
    onAddCustomStrategy: () => strategyState.addCustomStrategy(),
    onUpdateCustomStrategy: strategyState.updateCustomStrategy,
    onRemoveCustomStrategy: (id: string) => {
      strategyState.removeCustomStrategy(id)
      notify('已删除自定义策略', 'success')
    },
  }

  return (
    <div className="min-h-screen bg-app">
      {/*
        顶部安全区：iOS「添加到主屏幕」后是 black-translucent 全屏模式，
        内容会顶到状态栏下面，时间/信号压住标题、按钮也点不到。
        这里用 safe-top 把内容推到刘海下方，同时保留沉浸式背景色。
      */}
      <div className="safe-top mx-auto w-full max-w-[480px] px-4 pb-16">
        {storageError ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-[12px] tone-warn">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>{storageError}</span>
          </div>
        ) : null}

        {recovered ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-line bg-s2 px-3.5 py-2.5 text-[12px] text-ink2">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 tone-warn" />
            <span className="flex-1">
              检测到本地数据缺失或损坏，已恢复为默认分类。
            </span>
            <button type="button" className="shrink-0 text-ink4 underline" onClick={dismissRecovered}>
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
          themeMode={themeMode}
          onCycleTheme={cycleTheme}
          onOpenSettings={() => setSettingsSheetOpen(true)}
          // 首页关了「投资策略」区块，顶部就不再显示「当前策略 · 偏离度」这一行
          strategyStatus={strategyStatusFor(settingsState.settings.home.visible.strategy, {
            text: statusLine(rebalance),
            level: rebalance.health,
          })}
          fx={{
            hasForeign: exposure.foreignItemCount > 0,
            loading: fx.loading,
            stale: fx.stale,
            sourceLabel: fx.sourceLabel,
            currencies: exposure.byCurrency.map((b) => b.currency),
          }}
        />

        {/* 第二个数字：所有分期计划的「每月还款合计」（每季 ÷3、每年 ÷12） */}
        {installmentsState.monthlyCny > 0 ? (
          <div
            className="mt-2.5 flex items-center justify-between rounded-2xl border border-line bg-s2 px-3.5 py-2.5 text-[11.5px]"
            data-testid="monthly-installment"
          >
            <span className="text-ink4">
              每月还款合计
              <span className="ml-1.5">
                （{installmentsState.plans.filter((plan) => plan.remainingTerms > 0).length} 个分期计划）
              </span>
            </span>
            <span className="font-medium tabular-nums text-ink1">{formatCNY(installmentsState.monthlyCny)} 元</span>
          </div>
        ) : null}

        {/* 汇率缺失时明确提示，避免把原币数字误当成人民币 */}
        {exposure.missingRateCount > 0 ? (
          <div className="notice-warn mt-3">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              有 {exposure.missingRateCount} 条外币资产暂时拿不到汇率，已按原币数值计入，
              金额可能偏大。请检查网络后点右上角刷新。
            </span>
          </div>
        ) : null}

        {/* 分区标题 */}
        <div className="mt-7 flex items-end justify-between px-1">
          <div>
            <h2 className="text-[13px] font-medium text-ink2">资产分类</h2>
            <p className="mt-0.5 text-[11px] text-ink4">
              {portfolio.categories.length} 个分类 · {stats.items} 条记录
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCategoryForm({ open: true, initial: null })}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-s2 px-2.5 py-1.5 text-[12px] text-ink2 transition hover:bg-s3 active:scale-95"
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
              rates={fx.rates}
              dueReminders={installmentsState.plans
                .filter((plan) => plan.categoryId === category.id)
                .reduce((sum, plan) => sum + installmentsState.dueCount(plan), 0)}
              planMonthly={installmentsState.plans
                .filter((plan) => plan.categoryId === category.id)
                .reduce((sum, plan) => sum + monthlyPressure(plan), 0)}
              onOpen={(c) => setOpenCategoryId(c.id)}
            />
          ))}

          {portfolio.categories.length === 0 ? (
            <div className="rounded-card border border-dashed border-line px-4 py-10 text-center">
              <p className="text-[13px] text-ink3">还没有任何资产分类</p>
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

        {/*
          中间区块：显示哪些、按什么顺序，由设置 →「首页显示」决定。
          key 用区块 id，拖拽改顺序时 React 会复用同一节点，动画才不会跳。
        */}
        {settingsState.settings.home.order.map((id) =>
          settingsState.settings.home.visible[id] ? <Fragment key={id}>{homeBlocks[id]}</Fragment> : null,
        )}

        {/* 数据管理 */}
        <div className="mt-6">
          <h2 className="px-1 text-[13px] font-medium text-ink2">数据管理</h2>
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
          <p className="mt-3 px-1 text-[11px] leading-relaxed text-ink4">
            纯前端应用：所有数据仅保存在本机浏览器的 localStorage，清除浏览器数据会同时清空记录，建议定期导出备份。
          </p>
        </div>
      </div>

      {/* 批量导入持仓（基金 / 股票） */}
      <HoldingImportSheet
        open={importOpen}
        onClose={() => setImportOpen(false)}
        defaultType={openCategory && /股票/.test(openCategory.name) ? 'stock' : 'fund'}
        targetCategory={(type) => {
          const target = type === 'fund' ? importTargets.fund : importTargets.stock
          return target ? { id: target.id, name: target.name } : undefined
        }}
        existing={existingHoldings}
        onImport={handleHoldingImport}
        notify={notify}
      />

      {/* 单笔资产的策略映射 */}
      <ItemMappingSheet
        open={!!mappingTarget}
        onClose={() => setMappingTarget(null)}
        item={mappingTarget?.item ?? null}
        category={mappingTarget?.category ?? null}
        strategy={strategyState.strategy}
        autoMix={mappingTarget ? assetMix.autoMixOf(mappingTarget.item)?.mix : undefined}
        mixInfo={mappingTarget ? assetMix.entryOf(mappingTarget.item) : undefined}
        rule={mappingTarget ? strategyState.itemMapping[itemKeyOf(mappingTarget.item)] : undefined}
        value={
          mappingTarget
            ? valuate(mappingTarget.item, fx.rates).value
            : undefined
        }
        categoryEntries={mappingTarget ? strategyState.mapping[mappingTarget.category.id] : undefined}
        onSave={(rule) => {
          if (mappingTarget) strategyState.setItemMapping(itemKeyOf(mappingTarget.item), rule)
        }}
        notify={notify}
      />

      {/* 详情面板 */}
      <DetailSheet
        category={openCategory}
        index={portfolio.categories.findIndex((c) => c.id === openCategoryId)}
        total={portfolio.categories.length}
        syncing={sync.loading}
        rates={fx.rates}
        cashCandidates={settingsState.candidates}
        plans={installmentsState.plans}
        depositTargets={depositTargets}
        onSavePlan={(itemId, plan, enabled) => {
          if (!enabled || !plan) {
            const existing = installmentsState.planForItem(itemId)
            if (existing) installmentsState.deletePlan(existing.id)
            return
          }
          installmentsState.savePlan(plan)
        }}
        onConfirmTerm={(plan) => {
          const out = installmentsState.confirmTerm(plan)
          notify(out.ok ? (out.message ?? '已扣款') : (out.reason ?? '扣款失败'), out.ok ? 'success' : 'error')
        }}
        onSkipReminder={(plan) => {
          installmentsState.skipReminder(plan)
          notify('已忽略这次的还款提醒，下次按新的扣款日提示', 'info')
        }}
        dueCount={installmentsState.dueCount}
        fundDefault={settingsState.settings.fund}
        onRememberFunding={settingsState.setFundingSource}
        onOpenImport={() => setImportOpen(true)}
        mappingLabelOf={mappingLabelOf}
        onOpenMapping={(item, category) => setMappingTarget({ item, category })}
        onAddFundedItem={(categoryId, item, source, amount) => {
          addFundedItem(categoryId, item, source.categoryId, source.itemId, amount)
          notify(`已从「${source.itemName}」划拨 ${formatCNY(amount, 0)} 元买入`, 'success')
        }}
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

      {/* 设置：基金申购 + 薪资 */}
      <SettingsSheet
        open={settingsSheetOpen}
        settings={settingsState.settings}
        portfolio={portfolio}
        candidates={settingsState.candidates}
        initialPage={settingsPage}
        onClose={() => {
          setSettingsSheetOpen(false)
          setSettingsPage(undefined)
        }}
        onSetFundDefault={settingsState.setFundDefault}
        onSetFundingSource={settingsState.setFundingSource}
        onSetTrends={settingsState.setTrends}
        onSetHomeVisible={settingsState.setHomeVisible}
        onSetHomeOrder={settingsState.setHomeOrder}
        onNudgeHomeBlock={settingsState.nudgeHomeBlock}
        strategyPanel={strategyFormProps}
        dividends={dividendsState}
        dividendSettings={settingsState.settings.dividends}
        onSetDividendSettings={settingsState.setDividendSettings}
        rates={fx.rates}
        notify={notify}
        onSetFixed={settingsState.setFixed}
        onUpsertSalary={(month, amount) => {
          settingsState.upsertSalary(month, amount)
          notify(`已记录 ${formatMonth(month)} 薪资`, 'success')
        }}
        onRemoveSalary={(month) => {
          settingsState.removeSalary(month)
          notify(`已删除 ${formatMonth(month)} 记录`, 'success')
        }}
        onApplySalary={(month) => {
          const r = settingsState.applySalary(month)
          notify(r.message, r.ok ? 'success' : 'error')
          return r
        }}
      />

      {/* 策略配置弹层（首页策略卡片的齿轮）：与设置里的「投资策略」页共用同一份表单 */}
      <StrategySettingsSheet
        open={strategySheetOpen}
        onClose={() => setStrategySheetOpen(false)}
        defaultMapping={defaultMapping}
        {...strategyFormProps}
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
