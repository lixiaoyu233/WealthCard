import { useEffect, useMemo, useState } from 'react'
import { Check, Info, LayoutTemplate, Plus, RotateCcw, Trash2, TriangleAlert, Wallet } from 'lucide-react'
import type { Category } from '../types/asset'
import type { MappingEntry, Strategy, StrategySettings } from '../types/strategy'
import { BUILTIN_STRATEGIES, CLASS_COLORS, isStrategyValid, strategyTotal } from '../lib/strategies'
import { shortStrategyName } from '../lib/rebalance'
import { formatCNY } from '../lib/format'
import Sheet from './Sheet'

interface StrategySettingsSheetProps {
  open: boolean
  settings: StrategySettings
  strategy: Strategy
  /** 当前策略下每个分类最终生效的映射 */
  mapping: Record<string, MappingEntry[]>
  /** 内置默认映射，用于「恢复默认」 */
  defaultMapping: Record<string, MappingEntry[]>
  categories: Category[]
  /** 分类当前市值 */
  categoryValues: Record<string, number>
  onClose: () => void
  onSelectStrategy: (id: string) => void
  onThresholdChange: (v: number) => void
  onIncludeLiabilitiesChange: (v: boolean) => void
  onSetMapping: (categoryId: string, entries: MappingEntry[]) => void
  onResetMapping: () => void
  onAddCustomStrategy: () => Strategy
  onUpdateCustomStrategy: (id: string, patch: Partial<Omit<Strategy, 'id' | 'kind'>>) => void
  onRemoveCustomStrategy: (id: string) => void
}

type Tab = 'strategy' | 'mapping'

export default function StrategySettingsSheet(props: StrategySettingsSheetProps) {
  const {
    open,
    settings,
    strategy,
    mapping,
    categories,
    categoryValues,
    onClose,
    onSelectStrategy,
    onResetMapping,
    onSetMapping,
    onAddCustomStrategy,
    onUpdateCustomStrategy,
    onRemoveCustomStrategy,
  } = props

  const [tab, setTab] = useState<Tab>('strategy')

  useEffect(() => {
    if (open) setTab('strategy')
  }, [open])

  const allStrategies = useMemo(
    () => [...BUILTIN_STRATEGIES, ...settings.customStrategies],
    [settings.customStrategies],
  )

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="策略配置"
      subtitle={`当前：${strategy.name}`}
      leading={
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-zinc-300">
          <LayoutTemplate size={17} />
        </span>
      }
    >
      {/* 分段控件 */}
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-white/[0.06] bg-white/[0.03] p-1">
        {(
          [
            ['strategy', '策略与参数'],
            ['mapping', '资产映射'],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg py-2 text-[13px] transition ${
              tab === key ? 'bg-white text-black' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'strategy' ? (
        <StrategyTab
          {...props}
          allStrategies={allStrategies}
          onSelectStrategy={onSelectStrategy}
          onAddCustomStrategy={() => {
            const created = onAddCustomStrategy()
            setTab('strategy')
            return created
          }}
          onUpdateCustomStrategy={onUpdateCustomStrategy}
          onRemoveCustomStrategy={onRemoveCustomStrategy}
        />
      ) : (
        <MappingTab
          strategy={strategy}
          mapping={mapping}
          categories={categories}
          categoryValues={categoryValues}
          onSetMapping={onSetMapping}
          onResetMapping={onResetMapping}
        />
      )}
      {/* 阈值等参数放在两个 tab 之外，随时可调 */}
    </Sheet>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 1：策略与参数
 * ------------------------------------------------------------------ */

function StrategyTab(
  props: StrategySettingsSheetProps & {
    allStrategies: Strategy[]
    onAddCustomStrategy: () => Strategy
  },
) {
  const {
    settings,
    strategy,
    allStrategies,
    onSelectStrategy,
    onThresholdChange,
    onIncludeLiabilitiesChange,
    onUpdateCustomStrategy,
    onRemoveCustomStrategy,
  } = props

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Strategy | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (strategy.kind === 'custom') setDraft({ ...strategy, classes: strategy.classes.map((c) => ({ ...c })) })
    else setDraft(null)
    setEditing(false)
    setError(null)
    // 只在切换策略时重置草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id])

  const total = draft ? strategyTotal(draft) : 0
  const roundedTotal = Math.round(total * 100) / 100
  const totalOk = Math.abs(roundedTotal - 100) <= 0.01

  const saveDraft = () => {
    if (!draft) return
    const check = isStrategyValid(draft)
    if (!check.ok) {
      setError(check.message ?? '比例不合法')
      return
    }
    onUpdateCustomStrategy(draft.id, {
      name: draft.name.trim() || '自定义策略',
      description: draft.description,
      classes: draft.classes.map((c) => ({ ...c, target: Math.round(c.target * 100) / 100 })),
    })
    setEditing(false)
    setError(null)
  }

  return (
    <div className="space-y-5">
      {/* ---------------- 策略选择 ---------------- */}
      <div>
        <p className="field-label">选择策略</p>
        <ul className="space-y-2">
          {allStrategies.map((s) => {
            const active = s.id === settings.activeStrategyId
            const valid = isStrategyValid(s)
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelectStrategy(s.id)}
                  className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                    active
                      ? 'border-white/25 bg-white/[0.07]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-zinc-100">{s.name}</span>
                    {s.kind === 'custom' ? (
                      <span className="shrink-0 rounded-full border border-white/[0.08] px-1.5 py-0.5 text-[10px] text-zinc-500">
                        自定义
                      </span>
                    ) : null}
                    {active ? <Check size={15} className="shrink-0 text-emerald-400" /> : null}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">{s.description}</p>
                  {/* 目标比例条 */}
                  <span className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                    {s.classes.map((c) => (
                      <span
                        key={c.id}
                        style={{ width: `${Math.max(0, Math.min(100, c.target))}%`, backgroundColor: c.color }}
                        title={`${c.name} ${c.target}%`}
                      />
                    ))}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-[10.5px] text-zinc-600">
                    {s.classes.map((c) => (
                      <span key={c.id} className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.color }} />
                        {c.name} {c.target}%
                      </span>
                    ))}
                    {!valid.ok ? <span className="text-amber-400">（{valid.message}）</span> : null}
                  </span>
                </button>

                {/* 自定义策略：编辑 / 删除 */}
                {s.kind === 'custom' && active ? (
                  <div className="mt-1.5 flex gap-2">
                    <button type="button" className="btn-ghost flex-1 py-2 text-[12.5px]" onClick={() => setEditing((v) => !v)}>
                      {editing ? '收起编辑' : '编辑比例'}
                    </button>
                    <button
                      type="button"
                      className="btn-danger px-3 py-2"
                      onClick={() => onRemoveCustomStrategy(s.id)}
                      aria-label="删除该自定义策略"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>

        <button type="button" className="btn-ghost mt-2 w-full" onClick={() => props.onAddCustomStrategy()}>
          <Plus size={14} /> 新建自定义策略
        </button>
      </div>

      {/* ---------------- 自定义策略编辑 ---------------- */}
      {editing && draft ? (
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5">
          <div className="space-y-3">
            <div>
              <label className="field-label">策略名称</label>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="field-input"
              />
            </div>
            <div>
              <label className="field-label">描述</label>
              <input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="如 股 4 债 4 金 2"
                className="field-input"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="field-label mb-0">资产类别与目标比例</span>
                <span className={`text-[12px] font-medium tabular-nums ${totalOk ? 'text-emerald-400' : 'text-red-400'}`}>
                  合计 {roundedTotal}%
                </span>
              </div>
              <ul className="space-y-2">
                {draft.classes.map((c, i) => (
                  <li key={c.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="切换颜色"
                      onClick={() => {
                        const next = [...draft.classes]
                        const idx = CLASS_COLORS.indexOf(c.color)
                        next[i] = { ...c, color: CLASS_COLORS[(idx + 1) % CLASS_COLORS.length] }
                        setDraft({ ...draft, classes: next })
                      }}
                      className="h-6 w-6 shrink-0 rounded-full border border-white/10"
                      style={{ backgroundColor: `${c.color}55` }}
                    />
                    <input
                      value={c.name}
                      onChange={(e) => {
                        const next = [...draft.classes]
                        next[i] = { ...c, name: e.target.value }
                        setDraft({ ...draft, classes: next })
                      }}
                      placeholder="类别名称"
                      className="field-input flex-1 py-2 text-[13px]"
                    />
                    <div className="relative w-[86px] shrink-0">
                      <input
                        value={String(c.target)}
                        onChange={(e) => {
                          const next = [...draft.classes]
                          next[i] = { ...c, target: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 }
                          setDraft({ ...draft, classes: next })
                        }}
                        inputMode="decimal"
                        className="field-input py-2 pr-6 text-right text-[13px] tabular-nums"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">
                        %
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label="删除该类别"
                      disabled={draft.classes.length <= 1}
                      onClick={() => setDraft({ ...draft, classes: draft.classes.filter((_, j) => j !== i) })}
                      className="shrink-0 rounded-full p-2 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="btn-ghost mt-2 w-full py-2 text-[12.5px]"
                onClick={() =>
                  setDraft({
                    ...draft,
                    classes: [
                      ...draft.classes,
                      {
                        id: `class_${Date.now().toString(36)}`,
                        name: '新类别',
                        target: 0,
                        color: CLASS_COLORS[draft.classes.length % CLASS_COLORS.length],
                      },
                    ],
                  })
                }
              >
                <Plus size={13} /> 添加资产类别
              </button>
              {!totalOk ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-red-400">
                  <TriangleAlert size={12} /> 目标比例合计必须等于 100%（当前 {roundedTotal}%）
                </p>
              ) : null}
            </div>

            {error ? <p className="text-[12px] text-red-400">{error}</p> : null}

            <div className="flex gap-2.5">
              <button type="button" className="btn-primary flex-1" onClick={saveDraft} disabled={!totalOk}>
                保存策略
              </button>
              <button
                type="button"
                className="btn-ghost px-4"
                onClick={() => {
                  setDraft({ ...strategy, classes: strategy.classes.map((c) => ({ ...c })) })
                  setEditing(false)
                  setError(null)
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------- 参数 ---------------- */}
      <div className="space-y-3 border-t border-white/[0.06] pt-4">
        <p className="field-label">再平衡参数</p>

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-zinc-200">偏离阈值</span>
            <span className="text-[13px] font-medium tabular-nums text-zinc-100">{settings.threshold}%</span>
          </div>
          <input
            type="range"
            min={1}
            max={20}
            step={0.5}
            value={settings.threshold}
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            className="mt-2.5 w-full accent-[#f0b90b]"
            aria-label="偏离阈值"
          />
          <p className="mt-1.5 text-[11px] text-zinc-600">
            实际占比与目标相差超过该百分点时才建议操作（默认 5%，越小越敏感）
          </p>
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <span>
            <span className="block text-[13px] text-zinc-200">负债计入占比分母</span>
            <span className="mt-0.5 block text-[11px] text-zinc-600">
              关闭时按「可投资资产」算占比（推荐）
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.includeLiabilities}
            onChange={(e) => onIncludeLiabilitiesChange(e.target.checked)}
            className="h-4 w-4 accent-red-500"
          />
        </label>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
          <Info size={12} className="mt-0.5 shrink-0" />
          所有计算都在本地浏览器完成；策略、阈值与映射会一并保存在 localStorage。
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tab 2：资产映射
 * ------------------------------------------------------------------ */

function MappingTab({
  strategy,
  mapping,
  categories,
  categoryValues,
  onSetMapping,
  onResetMapping,
}: {
  strategy: Strategy
  mapping: Record<string, MappingEntry[]>
  categories: Category[]
  categoryValues: Record<string, number>
  onSetMapping: (categoryId: string, entries: MappingEntry[]) => void
  onResetMapping: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
        <Wallet size={14} className="mt-0.5 shrink-0 text-zinc-500" />
        <p className="text-[11.5px] leading-relaxed text-zinc-500">
          把你在「资产卡包」里的分类对应到策略资产类别。基金持仓会按名称自动识别为股票型 / 债券型后再归类；
          需要拆分时（如 60% 算股票、40% 算债券）填写两个比例。
        </p>
      </div>

      <ul className="space-y-3">
        {categories.map((category) => {
          const entries = mapping[category.id] ?? []
          const value = categoryValues[category.id] ?? 0
          const percentSum = entries.reduce((sum, e) => sum + e.percent, 0)
          const sumOk = Math.abs(percentSum - 100) <= 0.01

          return (
            <li
              key={category.id}
              data-testid={`mapping-row-${category.id}`}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3"
            >
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 shrink-0 rounded-lg" style={{ backgroundColor: `${category.color}26` }}>
                  <span className="flex h-full w-full items-center justify-center">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: category.color }} />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-100">{category.name}</span>
                <span className="shrink-0 text-[11.5px] tabular-nums text-zinc-500">{formatCNY(value, 0)} 元</span>
              </div>

              {category.isLiability ? (
                <p className="mt-1.5 text-[11px] text-zinc-600">负债类：不参与买入建议，仅按设置决定是否计入分母</p>
              ) : null}

              <div className="mt-2.5 space-y-2">
                {entries.map((entry, i) => (
                  <div key={`${entry.strategyClassId}-${i}`} className="flex items-center gap-2">
                    <select
                      data-testid={`mapping-select-${category.id}`}
                      value={entry.strategyClassId}
                      onChange={(e) => {
                        const next = [...entries]
                        next[i] = { ...entry, strategyClassId: e.target.value }
                        onSetMapping(category.id, next)
                      }}
                      className="field-input flex-1 py-1.5 text-[12.5px]"
                    >
                      {strategy.classes.map((c) => (
                        <option key={c.id} value={c.id} className="bg-[#141414]">
                          {c.name}（目标 {c.target}%）
                        </option>
                      ))}
                    </select>
                    <div className="relative w-[78px] shrink-0">
                      <input
                        value={String(entry.percent)}
                        onChange={(e) => {
                          const next = [...entries]
                          next[i] = { ...entry, percent: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 }
                          onSetMapping(category.id, next)
                        }}
                        inputMode="decimal"
                        className="field-input py-1.5 pr-6 text-right text-[12.5px] tabular-nums"
                      />
                      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-zinc-500">
                        %
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label="删除该映射"
                      disabled={entries.length <= 1}
                      onClick={() => onSetMapping(category.id, entries.filter((_, j) => j !== i))}
                      className="shrink-0 rounded-full p-1.5 text-zinc-600 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="text-[11.5px] text-zinc-400 underline-offset-2 hover:underline"
                  onClick={() => {
                    const used = new Set(entries.map((e) => e.strategyClassId))
                    const free = strategy.classes.find((c) => !used.has(c.id))
                    if (!free) return
                    // 新增一条 50%，并从现有条目里等比让出 50%，保证合计仍是 100%
                    const next = entries.map((e) => ({ ...e, percent: Number((e.percent / 2).toFixed(2)) }))
                    next.push({ strategyClassId: free.id, percent: 50 })
                    onSetMapping(category.id, next)
                  }}
                  disabled={entries.length >= strategy.classes.length}
                >
                  + 拆分到多个类别
                </button>
                {!sumOk ? (
                  <span className="text-[11px] text-amber-400">合计 {Math.round(percentSum)}%，将自动归一化</span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>

      <button type="button" className="btn-ghost w-full" onClick={onResetMapping}>
        <RotateCcw size={14} /> 恢复默认映射
      </button>

      <p className="text-[11px] leading-relaxed text-zinc-600">
        当前策略共 {strategy.classes.length} 个资产类别：
        {strategy.classes.map((c) => `${c.name} ${c.target}%`).join(' / ')}
      </p>
      <p className="text-[11px] text-zinc-600">策略：{shortStrategyName(strategy.name)}</p>
    </div>
  )
}
