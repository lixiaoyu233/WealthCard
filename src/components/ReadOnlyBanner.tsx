import { Lock } from 'lucide-react'

/**
 * 只读模式提示横幅（Phase 8 / W1）
 *
 * 为什么必须常驻且不可关闭：
 * W1 把业务事实源切到 IndexedDB 后，旧界面的编辑功能被停用。
 * 如果用户看不到任何说明，会以为「应用坏了」或「数据丢了」——
 * 实际上数据完好，只是编辑入口暂时关闭。
 *
 * 同时它也是「禁止假成功」的一部分：
 * 用户尝试编辑时除了错误提示，界面上必须始终能看出当前是只读状态。
 */
export default function ReadOnlyBanner({ message }: { message?: string }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-2xl border border-line bg-s2 px-3.5 py-2.5 text-[12px] text-ink2">
      <Lock size={14} className="mt-0.5 shrink-0 text-ink3" />
      <span className="flex-1">
        <span className="font-medium text-ink">只读预览模式</span>
        <span className="mx-1">·</span>
        资产管理 2.0 正在上线，此期间无法修改数据。你的数据已安全迁移，不会丢失。
        {message ? <span className="mt-1 block text-ink4">{message}</span> : null}
      </span>
    </div>
  )
}

export { ReadOnlyBanner }
