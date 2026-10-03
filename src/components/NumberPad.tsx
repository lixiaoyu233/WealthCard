import { Delete, X } from 'lucide-react'

interface NumberPadProps {
  open: boolean
  /** 当前编辑的输入值（字符串，允许中途出现 "12." 这种非法中间态） */
  value: string
  /** 字段标题，如「金额 / 份额 / 单价」 */
  label: string
  /** 右侧单位，如 元 / 份 / 元/克 */
  unit?: string
  onChange: (next: string) => void
  onClose: () => void
  /** 快捷填入，如黄金常用克数 */
  quickValues?: Array<{ label: string; value: string }>
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'] as const

/**
 * 自研数字键盘：移动端录入金额比系统键盘更快，
 * 并且规避了部分输入法把 '.' 替换成 '。' 的问题。
 */
export default function NumberPad({ open, value, label, unit, onChange, onClose, quickValues }: NumberPadProps) {
  if (!open) return null

  const press = (key: string) => {
    if (key === '.') {
      if (value.includes('.')) return
      onChange(value === '' ? '0.' : `${value}.`)
      return
    }
    // 避免 "007" 这类前导零
    if (value === '0') {
      onChange(key)
      return
    }
    // 限制整数部分长度，防止溢出
    const [intPart] = value.split('.')
    if (!value.includes('.') && intPart.length >= 12) return
    onChange(value + key)
  }

  const backspace = () => onChange(value.slice(0, -1))

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="收起键盘"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in cursor-default bg-black/60"
      />
      <div
        className="relative w-full max-w-[480px] animate-sheet-in overflow-hidden rounded-t-[22px] border border-white/[0.08]
          bg-[#0d0d0d] sm:rounded-[22px]"
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
          <span className="text-[12px] text-zinc-500">{label}</span>
          <div className="flex items-center gap-2">
            <span className="max-w-[210px] truncate text-right text-[20px] font-semibold tabular-nums text-zinc-100">
              {value || '0'}
              {unit ? <span className="ml-1 text-[12px] font-normal text-zinc-500">{unit}</span> : null}
            </span>
            <button type="button" onClick={onClose} className="rounded-full p-1.5 text-zinc-500 hover:text-zinc-200" aria-label="完成">
              <X size={16} />
            </button>
          </div>
        </div>

        {quickValues && quickValues.length > 0 ? (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 py-2">
            {quickValues.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => onChange(q.value)}
                className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-[12px] text-zinc-300 active:scale-95"
              >
                {q.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-3 gap-px bg-white/[0.05] p-px">
          {KEYS.slice(0, 9).map((k) => (
            <PadKey key={k} label={k} onClick={() => press(k)} />
          ))}
          <PadKey label="." onClick={() => press('.')} />
          <PadKey label="0" onClick={() => press('0')} />
          <PadKey label="⌫" aria-label="退格" onClick={backspace}>
            <Delete size={20} />
          </PadKey>
        </div>

        <div className="safe-bottom grid grid-cols-2 gap-px bg-white/[0.05] p-px pt-0">
          <button
            type="button"
            onClick={() => onChange('')}
            className="bg-[#161616] py-3.5 text-[15px] text-zinc-400 transition active:bg-[#1f1f1f]"
          >
            清空
          </button>
          <button
            type="button"
            onClick={onClose}
            className="bg-[#f0b90b] py-3.5 text-[15px] font-semibold text-black transition active:bg-[#d8a509]"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

function PadKey({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  children?: React.ReactNode
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[58px] items-center justify-center bg-[#141414] text-[22px] font-medium text-zinc-100
        transition active:bg-[#242424]"
      {...rest}
    >
      {children ?? label}
    </button>
  )
}
