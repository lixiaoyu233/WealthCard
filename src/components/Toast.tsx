import { useEffect } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastMessage {
  id: number
  text: string
  tone: ToastTone
}

const icons = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const

const tones = {
  info: 'border-line bg-s2 text-ink2',
  success: 'border-down/25 bg-down/10 tone-good',
  error: 'border-danger/25 bg-danger/10 tone-danger',
} as const

/** 顶部轻提示，自动消失 */
export default function Toast({ toast, onDismiss }: { toast: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(onDismiss, toast.tone === 'error' ? 5200 : 2600)
    return () => window.clearTimeout(timer)
  }, [toast, onDismiss])

  if (!toast) return null
  const Icon = icons[toast.tone]

  return (
    /*
      放在底部而不是顶部：顶部在 Safari 里会被地址栏、在独立窗口模式下会被灵动岛/状态栏遮挡
      （env(safe-area-inset-top) 在 Safari 中为 0，压不住地址栏）。
      底部同时也更靠近拇指，且不会与任何顶部元素冲突。
    */
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[80] flex justify-center px-4 pb-[max(env(safe-area-inset-bottom,0px),16px)]">
      <div
        role="status"
        className={`pointer-events-auto flex max-w-[440px] animate-sheet-in items-start gap-2 rounded-2xl border px-3.5 py-3
          text-[13px] shadow-[0_10px_30px_-10px_rgba(0,0,0,0.9)] backdrop-blur ${tones[toast.tone]}`}
      >
        <Icon size={15} className="mt-0.5 shrink-0" />
        <span className="flex-1 leading-snug">{toast.text}</span>
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 transition hover:opacity-100" aria-label="关闭提示">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
