/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 子路径部署：使用相对路径 base，产物可直接放到任意子目录下。
// https://vitejs.dev/config/shared-options.html#base
export default defineConfig({
  base: './',
  plugins: [react()],
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
