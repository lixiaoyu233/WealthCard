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
  info: 'border-white/[0.08] bg-[#141414] text-zinc-200',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  error: 'border-red-500/25 bg-red-500/10 text-red-300',
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
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-[max(env(safe-area-inset-top),12px)]">
      <div
        role="status"
        className={`pointer-events-auto flex max-w-[440px] animate-sheet-in items-start gap-2 rounded-2xl border px-3.5 py-2.5
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
