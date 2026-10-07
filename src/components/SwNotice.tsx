import { Check, Loader2, RefreshCw } from 'lucide-react'

export interface SwNoticeProps {
  /** 当前页面缓存/运行的版本时间，如「10-07 17:09」 */
  runningTime: string
  /** 线上最新版本时间（拿不到就不显示） */
  remoteTime?: string
  /** 是否有新版本待应用 */
  updateReady: boolean
  /** 正在检查线上版本 */
  checking?: boolean
  /** 正在应用更新（点击后） */
  updating?: boolean
  onCheck?: () => void
  onUpdate: () => void
}

/**
 * 顶部「缓存版本」提示：位置紧跟在「本地数据 · 仅保存在此浏览器」下面一行。
 *
 * 三种状态：
 * - 已是最新：版本时间 + 纯文字「✓ 已是最新」（不可点，所以不做成按钮）+ 可点药丸「检查更新」
 * - 有新版本：版本时间 → 新版时间 + 品牌金药丸「点此更新」
 * - 更新中：按钮变「更新中…」并禁用（刷新由 SW 的 controllerchange 触发）
 */
export default function SwNotice({
  runningTime,
  remoteTime,
  updateReady,
  checking = false,
  updating = false,
  onCheck,
  onUpdate,
}: SwNoticeProps) {
  return (
    <div
      className="mt-1.5 flex min-h-[18px] flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]"
      data-testid="sw-notice"
      data-update-ready={updateReady}
    >
      <span className="text-ink4">
        缓存版本{' '}
        <span className="tabular-nums text-ink3">{runningTime}</span>
        {updateReady && remoteTime ? (
          <>
            <span className="mx-1 text-ink4">→</span>
            <span className="tabular-nums font-medium tone-warn">{remoteTime}</span>
          </>
        ) : null}
      </span>

      {updateReady ? (
        <button
          type="button"
          data-testid="sw-update"
          disabled={updating}
          onClick={onUpdate}
          className="chip-update"
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {updating ? '更新中…' : '点此更新'}
        </button>
      ) : (
        <>
          {/* 纯文字 + 图标：不能点就不该长成按钮（药丸=可点，是这套 UI 的约定） */}
          <span className="inline-flex items-center gap-1 text-ink4" data-testid="sw-latest">
            <Check size={11} className="tone-good" />
            已是最新
          </span>
          {onCheck ? (
            <button
              type="button"
              data-testid="sw-check"
              disabled={checking}
              onClick={onCheck}
              className="chip-button"
            >
              {checking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              {checking ? '检查中…' : '检查更新'}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
