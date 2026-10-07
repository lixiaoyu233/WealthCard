import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBuildTime } from '../lib/swCachePolicy'
import {
  applyWaitingUpdate,
  checkForUpdate,
  currentBuildId,
  fetchRemoteBuildId,
  registerServiceWorker,
  resolveUpdateDecision,
  type SwRegistrationLike,
} from '../lib/swUpdater'

export interface SwStatus {
  runningTime: string
  remoteTime?: string
  updateReady: boolean
  checking: boolean
  updating: boolean
  onCheck: () => void
  onUpdate: () => void
}

/**
 * 注册 Service Worker，并对外提供「当前缓存版本 / 是否有新版 / 更新」。
 *
 * - 只在生产构建注册（开发环境注册会干扰热更新）
 * - 不支持 SW（隐私模式等）时返回 undefined，界面不显示这一行
 */
export function useServiceWorker(): SwStatus | undefined {
  const runningId = useMemo(() => currentBuildId(), [])
  const registrationRef = useRef<SwRegistrationLike | undefined>(undefined)
  const [supported, setSupported] = useState(false)
  /** SW 侧上报「有 waiting 的 worker」—— 这只是信号，不等于"有新版本"（见下面的判断） */
  const [waiting, setWaiting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [remoteId, setRemoteId] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (import.meta.env.DEV) return
    let cancelled = false
    void (async () => {
      const registration = await registerServiceWorker({
        onUpdateReady: () => {
          if (!cancelled) setWaiting(true)
        },
      })
      if (cancelled || !registration) return
      registrationRef.current = registration
      setSupported(true)
      const remote = await fetchRemoteBuildId()
      if (!cancelled && remote) setRemoteId(remote)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onCheck = useCallback(() => {
    setChecking(true)
    void (async () => {
      try {
        const registration = registrationRef.current
        if (registration) await checkForUpdate(registration)
        const remote = await fetchRemoteBuildId()
        if (remote) setRemoteId(remote)
      } finally {
        setChecking(false)
      }
    })()
  }, [runningId])

  const onUpdate = useCallback(() => {
    const registration = registrationRef.current
    if (!registration) return
    setUpdating(true)
    if (!applyWaitingUpdate(registration)) {
      // 线上 sw.js 变了但新 SW 还没装好 → 主动检查一次；下次点就能更新
      void checkForUpdate(registration).then(() => setUpdating(false))
    }
    // 有 waiting 时不用收尾：新 SW 接管会触发 controllerchange → 页面刷新
  }, [])

  /** 判断逻辑抽成纯函数（见 swUpdater.resolveUpdateDecision，有单测覆盖这个坑） */
  const decision = resolveUpdateDecision({ runningId, remoteId, waiting })
  const { updateReady, shouldTakeOver } = decision

  // 版本相同却停在 waiting（页面已是最新 JS，只是 SW 没接管）→ 静默让它接管，不打扰用户
  useEffect(() => {
    if (!shouldTakeOver) return
    const registration = registrationRef.current
    if (registration) applyWaitingUpdate(registration)
  }, [shouldTakeOver])

  if (!supported) return undefined

  return {
    runningTime: formatBuildTime(runningId),
    remoteTime: remoteId ? formatBuildTime(remoteId) : undefined,
    updateReady,
    checking,
    updating,
    onCheck,
    onUpdate,
  }
}
