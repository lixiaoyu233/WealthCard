import { useMemo, useState } from 'react'
import { RotateCcw, Wand2 } from 'lucide-react'
import Sheet from './Sheet'
import type { AssetItem, Category } from '../types/asset'
import type { AssetMix, ItemMappingRule, Strategy } from '../types/strategy'
import { MIX_LABEL, MIX_KEYS } from '../types/strategy'
import { isFund } from '../lib/calc'
import { resolveItemMapping, mappingSourceLabel } from '../lib/itemMapping'
import { formatCNY } from '../lib/format'

export interface ItemMappingSheetProps {
  open: boolean
  onClose: () => void
  item: AssetItem | null
  category: Category | null
  strategy: Strategy
  /** 当前条目的穿透占比（有的话） */
  autoMix?: AssetMix
  /** 穿透缓存明细：报告期 / 基金类型 */
  mixInfo?: { reportDate?: string; ftype?: string; name?: string }
  /** 已保存的规则 */
  rule?: ItemMappingRule
  /** 该条目当前的市值（展示用） */
  value?: number
  /** 已经生效的分类级映射（回退用） */
  categoryEntries?: { strategyClassId: string; percent: number }[]
  /** 恢复自动识别 = 保存 undefined */
  onSave: (rule: ItemMappingRule | undefined) => void
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
}

type Mode = 'auto' | 'manual' | 'excluded'

/**
 * 单笔资产的映射编辑：
 * - 看得到「当前是按什么算的」（穿透·报告期 / 名称推测 / 分类映射 / 未归类）
 * - 可以手动指定各策略桶的占比（自己分割，如 40% 股 / 60% 债）
 * - 可以指定债券期限（长期/中期）
 * - 可以直接标成「不纳入配置」，或一键恢复自动识别
 */
export default function ItemMappingSheet({
  open,
  onClose,
  item,
  category,
  strategy,
  autoMix,
  mixInfo,
  rule,
  value,
  categoryEntries,
  onSave,
  notify,
}: ItemMappingSheetProps) {
  const resolved = useMemo(() => {
    if (!item || !category) return undefined
    return resolveItemMapping({
      item,
      category,
      strategy,
      itemMapping: rule ? { [ruleKey(item)]: rule } : undefined,
      categoryEntries,
      autoMix,
      autoMixOrigin: 'api',
      bondTerm: item.bondTerm,
    })
  }, [item, category, strategy, rule, categoryEntries, autoMix])

  const [mode, setMode] = useState<Mode>(() => (rule?.excluded ? 'excluded' : rule ? 'manual' : 'auto'))
  const [percent, setPercent] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const cls of strategy.classes) {
      const hit = rule?.entries?.find((e) => e.strategyClassId === cls.id)
      out[cls.id] = hit ? String(hit.percent) : ''
    }
    return out
  })
  const [bondTerm, setBondTerm] = useState<'long' | 'mid' | ''>(rule?.bondTerm ?? item?.bondTerm ?? '')

  const hasBondTiers = strategy.classes.some((c) => /债/.test(c.name)) && strategy.classes.length > 1
  const fillFromCurrent = () => {
    const out: Record<string, string> = {}
    for (const cls of strategy.classes) out[cls.id] = ''
    for (const e of resolved?.entries ?? []) out[e.strategyClassId] = String(Math.round(e.percent))
    setPercent(out)
  }

  const save = () => {
    if (!item) return
    if (mode === 'excluded') {
      onSave({ excluded: true, source: 'manual', updatedAt: Date.now() })
      notify(`「${item.name}」已设为不纳入配置`, 'success')
      onClose()
      return
    }
    if (mode === 'auto') {
      onSave(undefined)
      notify('已恢复自动识别', 'success')
      onClose()
      return
    }
    const entries = strategy.classes
      .map((cls) => ({ strategyClassId: cls.id, percent: Number(percent[cls.id] || 0) }))
      .filter((e) => e.percent > 0)
    if (entries.length === 0) {
      notify('请至少给一个资产类别填比例', 'error')
      return
    }
    const next: ItemMappingRule = { entries, source: 'manual', updatedAt: Date.now() }
    if (bondTerm) next.bondTerm = bondTerm
    onSave(next)
    notify(`已保存「${item.name}」的映射（${entries.length} 个类别）`, 'success')
    onClose()
  }

  const mixChips = autoMix
    ? MIX_KEYS.filter((k) => (autoMix[k] ?? 0) > 0.0005).map((k) => ({
        key: k,
        label: MIX_LABEL[k],
        percent: Math.round((autoMix[k] ?? 0) * 100),
      }))
    : []

  return (
    <Sheet
      open={open && !!item}
      title="设置这笔资产的映射"
      subtitle={item ? `${item.name}${isFund(item) && item.code ? ` · ${item.code}` : ''}` : ''}
      onClose={onClose}
      zClassName="z-[60]"
      footer={
        <div className="flex items-center gap-2.5">
          <button type="button" data-testid="mapping-save" className="btn-primary flex-1" onClick={save}>
            保存
          </button>
          <button
            type="button"
            data-testid="mapping-restore"
            className="btn-ghost px-3.5"
            onClick={() => {
              onSave(undefined)
              notify('已恢复自动识别', 'success')
              onClose()
            }}
          >
            <RotateCcw size={14} /> 恢复自动
          </button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="item-mapping-sheet">
        {/* 当前是怎么算的 */}
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          <p className="text-[12px] text-ink3">
            当前来源：
            <span className="ml-1 font-medium text-ink1" data-testid="mapping-source">
              {resolved ? mappingSourceLabel(resolved) : '未归类'}
            </span>
            {mixInfo?.reportDate ? <span className="ml-2 text-[11px] text-ink4">（{mixInfo.reportDate} 报告期）</span> : null}
          </p>
          {mixChips.length > 0 ? (
            <p className="mt-1.5 flex flex-wrap gap-1.5" data-testid="mapping-mix">
              {mixChips.map((c) => (
                <span key={c.key} className="chip">
                  {c.label} {c.percent}%
                </span>
              ))}
            </p>
          ) : null}
          {value !== undefined ? (
            <p className="mt-1.5 text-[11px] text-ink4">当前市值 {formatCNY(value, 2)} 元</p>
          ) : null}
        </div>

        {/* 模式 */}
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-s2 p-1">
          {([
            ['auto', '自动识别'],
            ['manual', '手动指定'],
            ['excluded', '不纳入配置'],
          ] as Array<[Mode, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              data-testid={`mapping-mode-${key}`}
              onClick={() => setMode(key)}
              className={`rounded-lg px-2 py-1.5 text-[12px] transition ${
                mode === key ? 'bg-s3 text-ink1' : 'text-ink4 hover:bg-s3'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'manual' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11.5px] text-ink4">给各资产类别填占比（合计不为 100 时按比例归一化）</p>
              <button type="button" className="text-[11.5px] text-ink3 underline-offset-2 hover:underline" onClick={fillFromCurrent}>
                <Wand2 size={12} className="mr-0.5 inline" />
                按当前识别填
              </button>
            </div>
            <ul className="space-y-1.5">
              {strategy.classes.map((cls) => (
                <li key={cls.id} className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: cls.color }} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink2">{cls.name}</span>
                  <input
                    data-testid={`mapping-percent-${cls.id}`}
                    value={percent[cls.id] ?? ''}
                    onChange={(e) => setPercent((prev) => ({ ...prev, [cls.id]: e.target.value.replace(/[^\d.]/g, '') }))}
                    inputMode="decimal"
                    placeholder="0"
                    className="field-input w-20 py-1 text-[12px] tabular-nums"
                  />
                  <span className="text-[11px] text-ink4">%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {mode === 'excluded' ? (
          <p className="rounded-2xl border border-line bg-s2 px-3.5 py-3 text-[11.5px] leading-relaxed text-ink4">
            这笔资产不会进入任何资产类别，也不计入占比分母（和「自住房 / 房贷」「保险年金」「分期划扣」一样）。
          </p>
        ) : null}

        {/* 债券期限 */}
        {hasBondTiers ? (
          <div className="flex items-center justify-between rounded-2xl border border-line bg-s2 px-3.5 py-2.5">
            <span className="text-[12.5px] text-ink2">债券期限</span>
            <div className="flex gap-1">
              {([
                ['', '未指定'],
                ['mid', '中期'],
                ['long', '长期'],
              ] as const).map(([v, label]) => (
                <button
                  key={v || 'none'}
                  type="button"
                  data-testid={`mapping-term-${v || 'none'}`}
                  onClick={() => setBondTerm(v)}
                  className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition ${
                    bondTerm === v ? 'border-line-strong bg-s3 text-ink1' : 'border-line bg-s2 text-ink4 hover:bg-s3'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  )
}

/** 与 itemMapping.ts 的 key 规则一致 */
function ruleKey(item: AssetItem): string {
  if (isFund(item) && item.code?.trim()) return `${item.market ?? 'cn'}:${item.code.trim().toUpperCase()}`
  return `id:${item.id}`
}
