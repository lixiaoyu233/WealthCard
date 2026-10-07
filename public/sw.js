/*
 * WealthCard Service Worker
 *
 * 职责：只缓存「文件」（HTML / JS / CSS / 图标 / manifest），
 *      让 App 在弱网、断网、加到主屏后也能秒开。
 *
 * 不做什么：不碰 localStorage 里的资产数据（SW 里也读不到），
 *          不缓存基金行情 / 汇率 / 穿透这些跨域实时接口。
 *
 * 更新策略（保守，避免把用户锁在旧版）：
 *   - 新 SW 安装后停在 waiting，**不会自动接管**；
 *   - 页面发现「有新版本」会提示用户，用户点更新后页面发 SKIP_WAITING 消息；
 *   - 新 SW activate 时按构建版本清掉旧缓存。
 *
 * __BUILD_ID__ 由 vite.config.ts 在构建时替换成构建时间（ISO）。
 */

const BUILD_ID = '__BUILD_ID__'
const CACHE_PREFIX = 'acw-static-'
const CACHE_NAME = CACHE_PREFIX + BUILD_ID.replace(/[^\w.-]/g, '_')

/** 预缓存：失败也不影响安装（比如某个图标 404） */
const PRECACHE_URLS = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

/* --- policy:start ---
 * 与 src/lib/swCachePolicy.ts 等价（SW 不能 import 打包产物）。
 * 两份实现由 swCachePolicy.test.ts 用同一张用例表比对，改动请同时改两边。
 */
function decideStrategy(request, siteOrigin) {
  var method = (request.method || 'GET').toUpperCase()
  if (method !== 'GET') return 'bypass'

  var url
  try {
    url = new URL(request.url)
  } catch (e) {
    return 'bypass'
  }
  if (url.origin !== siteOrigin) return 'bypass'
  if (request.mode === 'navigate') return 'network-first'

  var path = url.pathname
  if (path.endsWith('.html') || path.endsWith('/')) return 'network-first'
  // sw.js 自身不缓存：页面靠读它判断线上版本，缓存了会显示旧版本号
  if (path.endsWith('/sw.js')) return 'bypass'
  var isAsset =
    path.indexOf('/assets/') >= 0 ||
    /\.(?:js|css|png|jpe?g|svg|webp|gif|ico|woff2?|ttf|otf|json|webmanifest|txt|xml)$/i.test(path)
  if (isAsset) return 'cache-first'
  return 'bypass'
}
/* --- policy:end --- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      await Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {})))
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

// 页面点了「更新」→ 让 waiting 中的新 SW 立刻接管
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const strategy = decideStrategy(request, self.location.origin)
  if (strategy === 'bypass') return // 交给浏览器，绝不插手实时接口

  if (strategy === 'network-first') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(CACHE_NAME)
          cache.put(request, fresh.clone()).catch(() => {})
          return fresh
        } catch (e) {
          const cached = await caches.match(request)
          if (cached) return cached
          const shell = await caches.match('./')
          if (shell) return shell
          throw e
        }
      })(),
    )
    return
  }

  // cache-first
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const fresh = await fetch(request)
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE_NAME)
        cache.put(request, fresh.clone()).catch(() => {})
      }
      return fresh
    })(),
  )
})
