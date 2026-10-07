/**
 * Service Worker 的注册与「新版本」检测（纯逻辑，浏览器 API 全部可注入 → 可单测）。
 *
 * 更新流程（保守，绝不把用户锁在旧版、也不偷偷混用新旧）：
 *   1. 浏览器发现 sw.js 变了 → 安装新 SW → 停在 waiting（**不自动接管**）
 *   2. 页面收到信号 → 顶部提示「有新版本 · 点此更新」
 *   3. 用户点更新 → 给 waiting 发 SKIP_WAITING → 新 SW 接管 → controllerchange → 刷新
 */
import { buildIdFromSwSource, runningBuildId } from './swCachePolicy'

export interface ServiceWorkerLike {
  state?: string
  postMessage: (message: unknown) => void
  addEventListener: (type: string, listener: (event: unknown) => void) => void
}

export interface SwRegistrationLike {
  waiting?: ServiceWorkerLike | null
  installing?: ServiceWorkerLike | null
  addEventListener: (type: string, listener: (event: unknown) => void) => void
  update?: () => Promise<unknown>
}

export interface SwContainerLike {
  controller?: unknown
  register: (url: string, options?: { scope?: string }) => Promise<SwRegistrationLike>
  addEventListener: (type: string, listener: (event: unknown) => void) => void
}

export interface SwWatchHooks {
  /** 新版本已就绪（waiting），界面可以提示用户 */
  onUpdateReady?: () => void
}

/** 取得浏览器的 SW 容器；不支持（或测试环境没注入）时返回 undefined */
export function swContainer(): SwContainerLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const container = (navigator as Navigator & { serviceWorker?: SwContainerLike }).serviceWorker
  return container && typeof container.register === 'function' ? container : undefined
}

/** 只在生产构建 + 浏览器支持时注册（开发环境注册会干扰热更新） */
export function shouldRegister(options: { isDev?: boolean; container?: SwContainerLike | undefined } = {}): boolean {
  if (options.isDev) return false
  return !!options.container
}

/**
 * 监听注册对象，判断「是否有新版本」。
 * 关键细节：**只有已经存在 controller（说明不是首次安装）时才提示更新**，
 * 否则用户第一次打开就会看到「有新版本」，很莫名其妙。
 */
export function watchRegistration(
  registration: SwRegistrationLike,
  container: SwContainerLike,
  hooks: SwWatchHooks,
  reload: () => void,
): void {
  const notifyIfReady = () => {
    if (container.controller) hooks.onUpdateReady?.()
  }

  // 上次打开时装好但没应用就关掉了 → 这次直接判定有更新
  if (registration.waiting) notifyIfReady()

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') notifyIfReady()
    })
  })

  // 新 SW 接管后刷新；只刷一次，避免循环
  let reloaded = false
  container.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    reload()
  })
}

/** 让 waiting 中的新版本立刻接管（页面随后会因 controllerchange 刷新） */
export function applyWaitingUpdate(registration: SwRegistrationLike): boolean {
  if (!registration.waiting) return false
  registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  return true
}

/** 主动检查线上有没有新版（等价于刷新页面时的自动检查，用于「检查更新」按钮） */
export async function checkForUpdate(registration: SwRegistrationLike): Promise<void> {
  try {
    await registration.update?.()
  } catch {
    /* 离线 / 网络异常时静默失败，不打扰用户 */
  }
}

/** 读线上 sw.js 的 BUILD_ID（用于显示「线上版本」的时间） */
export async function fetchRemoteBuildId(
  fetchImpl: typeof fetch = fetch,
  url = './sw.js',
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url, { cache: 'no-store' })
    if (!res.ok) return undefined
    return buildIdFromSwSource(await res.text())
  } catch {
    return undefined
  }
}

export interface RegisterOptions extends SwWatchHooks {
  container?: SwContainerLike | undefined
  isDev?: boolean
  /** 注册路径（相对站点 base） */
  url?: string
  reload?: () => void
}

/** 注册 SW 并接好更新监听；返回注册对象（便于「检查更新」） */
export async function registerServiceWorker(
  options: RegisterOptions = {},
): Promise<SwRegistrationLike | undefined> {
  const container = 'container' in options ? options.container : swContainer()
  if (!shouldRegister({ isDev: options.isDev, container })) return undefined
  const reload = options.reload ?? (() => window.location.reload())
  try {
    const registration = await container!.register(options.url ?? './sw.js', { scope: './' })
    watchRegistration(registration, container!, options, reload)
    return registration
  } catch {
    return undefined // 注册失败（不支持 / 隐私模式）不影响 App 使用
  }
}

/** 当前运行版本（页面自己） */
export function currentBuildId(): string {
  return runningBuildId()
}

export interface UpdateDecision {
  /** 是否该提示用户「有新版本」 */
  updateReady: boolean
  /**
   * 是否该静默让 waiting 的 SW 接管。
   * 场景：页面导航是网络优先，刷新后可能已经是最新 JS，而 SW 还停在 waiting ——
   * 二者版本相同，不该打扰用户，直接让它接管即可。
   */
  shouldTakeOver: boolean
}

/**
 * 「有没有新版本」只看**版本号**，不看 SW 状态。
 *
 * 踩过的坑：只看「有 waiting + 有 controller」就提示更新，
 * 结果用户手动刷新后（页面已是新 JS）看到「10-07 17:25 → 10-07 17:25」这种莫名其妙的通知。
 */
export function resolveUpdateDecision(input: {
  runningId: string
  remoteId?: string
  waiting: boolean
}): UpdateDecision {
  const { runningId, remoteId, waiting } = input
  if (!remoteId) return { updateReady: false, shouldTakeOver: false }
  const different = remoteId !== runningId
  return {
    updateReady: different,
    shouldTakeOver: !different && waiting,
  }
}
