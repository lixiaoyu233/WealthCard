/**
 * Service Worker 的缓存策略（纯函数，可单测）。
 *
 * 设计原则：
 * 1. **只缓存「文件」**（HTML / JS / CSS / 图标 / manifest），绝不碰 localStorage 里的资产数据；
 * 2. **页面导航与 HTML 走网络优先** —— 一联网就拿到最新版本，断网才回退缓存；
 * 3. **带 hash 的构建产物走缓存优先** —— 文件名即内容指纹，永不变，可以放心长期缓存；
 * 4. **跨域请求一律放行不缓存** —— 基金行情 / 汇率 / 穿透 / 基金搜索这些必须实时，
 *    缓存了反而会出现"净值半天不动"的错觉。
 *
 * ⚠️ `public/sw.js` 里有一份等价实现（SW 无法 import 打包产物）。
 *    `swCachePolicy.test.ts` 会把两份实现放在同一张用例表上比对，防止漂移。
 */

export type SwStrategy = 'network-first' | 'cache-first' | 'bypass'

export interface SwRequestInfo {
  url: string
  /** `navigate` 表示这是一次页面导航 */
  mode?: string
  method?: string
}

/** 静态资源后缀：命中即缓存优先 */
const CACHE_FIRST_EXT =
  /\.(?:js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf|json|webmanifest|txt|xml)$/i

/** 站点自身的 origin 之外的都算跨域 */
export function decideStrategy(request: SwRequestInfo, siteOrigin: string): SwStrategy {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET') return 'bypass' // 写操作永不缓存

  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return 'bypass'
  }
  if (url.origin !== siteOrigin) return 'bypass' // 实时接口
  if (request.mode === 'navigate') return 'network-first'

  const path = url.pathname
  if (path.endsWith('.html') || path.endsWith('/')) return 'network-first'
  // ⚠️ sw.js 自身必须走网络：页面要靠读它来判断「线上有没有新版本」，
  //    如果被 SW 用缓存里的旧 sw.js 回应，显示的新版本号就是旧的（实测踩过）。
  if (path.endsWith('/sw.js')) return 'bypass'
  if (path.includes('/assets/') || CACHE_FIRST_EXT.test(path)) return 'cache-first'
  return 'bypass'
}

/** 缓存名带构建版本：换版本就换缓存，旧的自动淘汰（避免用户被锁在旧版） */
export function cacheNameOf(buildId: string): string {
  return `acw-static-${buildId.replace(/[^\w.-]/g, '_')}`
}

/** 从 sw.js 源码里读出它的 BUILD_ID（用来判断线上有没有新版） */
export function buildIdFromSwSource(source: string): string | undefined {
  const matched = source.match(/BUILD_ID\s*=\s*['"]([^'"]+)['"]/)
  return matched?.[1]
}

/** 当前运行的版本 vs 线上版本 */
export function isUpdateAvailable(runningId: string | undefined, remoteId: string | undefined): boolean {
  if (!runningId || !remoteId) return false
  return runningId !== remoteId
}

/**
 * 构建时间（ISO）→ 本地时间短文案，如「10-06 15:32:47」。
 * **精确到秒**是刻意的：只有分钟精度时，两次间隔不到一分钟的构建都会显示成同一时间，
 * 看起来像"新旧版本一样"，反而让人以为判断错了。
 */
export function formatBuildTime(buildId: string | undefined): string {
  if (!buildId) return '未知'
  const date = new Date(buildId)
  if (Number.isNaN(date.getTime())) return '未知'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 当前页面自己运行的是哪个构建（由 vite define 注入） */
export function runningBuildId(): string {
  // 用 typeof 兜底：万一没被 define 替换也不会抛 ReferenceError
  return typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'
}
