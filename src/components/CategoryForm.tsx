import { useEffect, useState } from 'react'
import { Check, Info, Trash2 } from 'lucide-react'
import type { Category } from '../types/asset'
import { CATEGORY_COLORS, CATEGORY_TEMPLATES } from '../lib/defaults'
import { ICON_NAMES, resolveIcon } from '../lib/icons'
import Sheet from './Sheet'

interface CategoryFormProps {
  open: boolean
  /** 传入表示编辑分类 */
  initial?: Category | null
  onSubmit: (patch: Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'isLiability'>) => void
  onDelete?: () => void
  onClose: () => void
}

export default function CategoryForm({ open, initial, onSubmit, onDelete, onClose }: CategoryFormProps) {
  const [name, setName] = useState('')
  const [subtitle, setSubtitle] = useState('')
  const [icon, setIcon] = useState('wallet')
  const [color, setColor] = useState(CATEGORY_COLORS[0])
  const [isLiability, setIsLiability] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setSubtitle(initial?.subtitle ?? '')
    setIcon(initial?.icon ?? 'wallet')
    setColor(initial?.color ?? CATEGORY_COLORS[Math.floor(Math.random() * CATEGORY_COLORS.length)])
    setIsLiability(initial?.isLiability ?? false)
    setError(null)
  }, [open, initial])

  const applyTemplate = (t: (typeof CATEGORY_TEMPLATES)[number]) => {
    setName(t.name)
    setSubtitle(t.subtitle)
    setIcon(t.icon)
    setColor(t.color)
    setIsLiability(t.isLiability ?? false)
  }

  const submit = () => {
    if (!name.trim()) {
      setError('请填写分类名称')
      return
    }
    onSubmit({ name: name.trim(), subtitle: subtitle.trim(), icon, color, isLiability })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={initial ? '编辑分类' : '新增分类'}
      subtitle={initial ? initial.name : '自定义一个资产分类卡片'}
      footer={
        <div className="flex items-center gap-2.5 pb-1">
          <button type="button" className="btn-primary flex-1" onClick={submit}>
            {initial ? '保存' : '创建分类'}
          </button>
          {initial && onDelete ? (
            <button type="button" className="btn-danger px-3.5" onClick={onDelete} aria-label="删除分类">
              <Trash2 size={15} />
            </button>
          ) : null}
          <button type="button" className="btn-ghost px-4" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {!initial ? (
          <div>
            <p className="field-label">快速模板</p>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-300 transition hover:bg-white/[0.08] active:scale-95"
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <label className="field-label">名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 数字货币" className="field-input" />
        </div>

        <div>
          <label className="field-label">副标题描述</label>
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="如 交易所 / 冷钱包"
            className="field-input"
          />
        </div>

        <div>
          <p className="field-label">图标</p>
          <div className="grid grid-cols-6 gap-2">
            {ICON_NAMES.map((key) => {
              const Icon = resolveIcon(key)
              const active = key === icon
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setIcon(key)}
                  aria-label={key}
                  className={`flex h-11 items-center justify-center rounded-xl border transition ${
                    active ? 'border-white/25 bg-white/[0.09]' : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.07]'
                  }`}
                  style={active ? { color } : { color: '#a1a1aa' }}
                >
                  <Icon size={18} />
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <p className="field-label">主题色</p>
          <div className="flex flex-wrap gap-2.5">
            {CATEGORY_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`主题色 ${c}`}
                className="flex h-8 w-8 items-center justify-center rounded-full border transition"
                style={{ backgroundColor: `${c}33`, borderColor: color === c ? c : 'transparent' }}
              >
                {color === c ? <Check size={14} style={{ color: c }} /> : null}
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
          <span>
            <span className="block text-[13px] text-zinc-200">计入负债</span>
            <span className="mt-0.5 block text-[11px] text-zinc-600">开启后该分类合计会从净资产中扣减</span>
          </span>
          <input
            type="checkbox"
            checked={isLiability}
            onChange={(e) => setIsLiability(e.target.checked)}
            className="h-4 w-4 accent-red-500"
          />
        </label>

        {error ? <p className="text-[12px] text-red-400">{error}</p> : null}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600">
          <Info size={12} className="mt-0.5 shrink-0" />
          分类与条目全部保存在浏览器 localStorage，不会上传到任何服务器。
        </p>
      </div>
    </Sheet>
  )
}
