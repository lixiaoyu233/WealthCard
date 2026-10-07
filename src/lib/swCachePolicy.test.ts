import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildIdFromSwSource,
  cacheNameOf,
  decideStrategy,
  formatBuildTime,
  isUpdateAvailable,
  type SwStrategy,
} from './swCachePolicy'

const SITE = 'https://lixiaoyu233.github.io'

/** 用例表：TS 与 sw.js 两份实现都要跑出同样的结果 */
const CASES: Array<{ name: string; req: { url: string; mode?: string; method?: string }; want: SwStrategy }> = [
  { name: '页面导航 → 网络优先', req: { url: `${SITE}/WealthCard/`, mode: 'navigate' }, want: 'network-first' },
  { name: 'index.html → 网络优先', req: { url: `${SITE}/WealthCard/index.html` }, want: 'network-first' },
  { name: '构建产物 js → 缓存优先', req: { url: `${SITE}/WealthCard/assets/index-CdSBaeGU.js` }, want: 'cache-first' },
  { name: '构建产物 css → 缓存优先', req: { url: `${SITE}/WealthCard/assets/index-jVP1DOG7.css` }, want: 'cache-first' },
  { name: '图标 → 缓存优先', req: { url: `${SITE}/WealthCard/icons/icon-192.png` }, want: 'cache-first' },
  { name: 'manifest → 缓存优先', req: { url: `${SITE}/WealthCard/manifest.webmanifest` }, want: 'cache-first' },
  { name: '基金行情（跨域）→ 放行不缓存', req: { url: 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?FCODES=161725' }, want: 'bypass' },
  { name: '汇率（跨域）→ 放行', req: { url: 'https://api.exchangerate.host/latest' }, want: 'bypass' },
  { name: '穿透数据（跨域）→ 放行', req: { url: 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNAssetAllocationNew?FCODE=510300' }, want: 'bypass' },
  { name: 'POST → 放行', req: { url: `${SITE}/WealthCard/api/x`, method: 'POST' }, want: 'bypass' },
  { name: '同源未知路径 → 放行（不猜）', req: { url: `${SITE}/WealthCard/whatever` }, want: 'bypass' },
  { name: '非法 URL → 放行', req: { url: 'not-a-url' }, want: 'bypass' },
  { name: 'sw.js → 走网络（不缓存，否则版本号显示是旧的）', req: { url: `${SITE}/WealthCard/sw.js` }, want: 'bypass' },
]

describe('缓存策略', () => {
  it.each(CASES)('$name', ({ req, want }) => {
    expect(decideStrategy(req, SITE)).toBe(want)
  })

  it('大小写不敏感的后缀判断', () => {
    expect(decideStrategy({ url: `${SITE}/WealthCard/Logo.PNG` }, SITE)).toBe('cache-first')
  })

  it('sw.js 自身必须走网络（缓存了会让页面读到旧版本号，显示"新版时间=旧时间"）', () => {
    expect(decideStrategy({ url: `${SITE}/WealthCard/sw.js` }, SITE)).toBe('bypass')
    // 带查询串的探测也要走网络
    expect(decideStrategy({ url: `${SITE}/WealthCard/sw.js?t=1` }, SITE)).toBe('bypass')
    // 但不能误伤别的 js
    expect(decideStrategy({ url: `${SITE}/WealthCard/assets/index-x.js` }, SITE)).toBe('cache-first')
  })
})

describe('版本与缓存名', () => {
  it('缓存名带版本，且不含非法字符', () => {
    const name = cacheNameOf('2026-10-06T07:32:10.123Z')
    expect(name.startsWith('acw-static-')).toBe(true)
    expect(name).not.toContain(':')
  })

  it('不同版本 → 不同缓存名（换版本自动淘汰旧缓存）', () => {
    expect(cacheNameOf('a')).not.toBe(cacheNameOf('b'))
  })

  it('从 sw.js 源码里能读出 BUILD_ID', () => {
    expect(buildIdFromSwSource("const BUILD_ID = '2026-10-06T07:32:10.123Z'")).toBe('2026-10-06T07:32:10.123Z')
    expect(buildIdFromSwSource('const BUILD_ID = "__BUILD_ID__"')).toBe('__BUILD_ID__')
    expect(buildIdFromSwSource('nothing here')).toBeUndefined()
  })

  it('版本不同才算有更新；读不到线上版本不误报', () => {
    expect(isUpdateAvailable('a', 'b')).toBe(true)
    expect(isUpdateAvailable('a', 'a')).toBe(false)
    expect(isUpdateAvailable('a', undefined)).toBe(false)
    expect(isUpdateAvailable(undefined, 'b')).toBe(false)
  })

  it('构建时间显示成本地时间短文案', () => {
    const iso = '2026-10-06T07:32:10.123Z'
    const text = formatBuildTime(iso)
    // 精确到秒：两次间隔不到一分钟的构建也能区分开（否则会显示成"新旧同一时间"）
    expect(text).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    // 用本地时区算一遍，确认没写死 UTC
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(text).toBe(
      `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    )
    expect(formatBuildTime(undefined)).toBe('未知')
    expect(formatBuildTime('dev')).toBe('未知')
  })
})

describe('sw.js 里的实现必须与 TS 版本一致（防漂移）', () => {
  const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')

  it('sw.js 里能找到策略代码块', () => {
    expect(swSource).toContain('/* --- policy:start ---')
    expect(swSource).toContain('/* --- policy:end --- */')
  })

  it('同一张用例表：sw.js 的实现给出完全相同的结论', () => {
    const block = swSource.slice(
      swSource.indexOf('/* --- policy:start ---'),
      swSource.indexOf('/* --- policy:end --- */'),
    )
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(`${block}\n return decideStrategy`) as () => (
      request: { url: string; mode?: string; method?: string },
      siteOrigin: string,
    ) => string
    const swDecide = factory()
    for (const c of CASES) {
      expect(swDecide(c.req, SITE), `sw.js 对「${c.name}」的判定`).toBe(c.want)
    }
  })

  it('sw.js 里预置了 __BUILD_ID__ 占位符（构建时替换）', () => {
    expect(swSource).toContain("const BUILD_ID = '__BUILD_ID__'")
  })
})
