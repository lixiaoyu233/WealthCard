/// <reference types="vitest" />
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 本次构建的版本号（ISO 时间）。
 * 同一个进程里只算一次，保证「页面里的版本」与「sw.js 里的版本」完全一致 ——
 * 否则页面每次都会以为有新版本。
 */
const BUILD_ID = new Date().toISOString()

/**
 * 把 BUILD_ID 写进 dist/sw.js（public/ 里的文件不会被 Vite 改写，只能构建后替换）。
 * sw.js 里换版本 → 缓存名变化 → activate 时清掉旧缓存，用户不会被锁在旧版。
 */
function serviceWorkerBuildId(): Plugin {
  return {
    name: 'acw-sw-build-id',
    apply: 'build',
    closeBundle() {
      const file = resolve(__dirname, 'dist/sw.js')
      if (!existsSync(file)) return
      const source = readFileSync(file, 'utf8')
      if (!source.includes('__BUILD_ID__')) return
      writeFileSync(file, source.replaceAll('__BUILD_ID__', BUILD_ID))
    },
  }
}

// GitHub Pages 子路径部署：使用相对路径 base，产物可直接放到任意子目录下。
// https://vitejs.dev/config/shared-options.html#base
export default defineConfig({
  base: './',
  // 页面侧用它显示「当前缓存版本」并判断有没有新版
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), serviceWorkerBuildId()],
  server: {
    port: 5173,
    open: false,
    // 本地开发时的可选代理（生产环境走 CORS/JSONP，无需代理）。
    // 若浏览器直连被拦截，可把 fundService 的 provider 切到 '/eastmoney' 前缀。
    proxy: {
      '/eastmoney': {
        target: 'https://fundmobapi.eastmoney.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/eastmoney/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2019',
  },
  test: {
    // 默认 node：纯函数与存储相关的用例跑得快
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 组件用例在文件头用 `// @vitest-environment jsdom` 单独切换；
    // 浏览器 API 的替身集中在 setup 里
    setupFiles: ['./src/test/setup.ts'],
  },
})
