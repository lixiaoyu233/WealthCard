import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import App2 from './pages/App2'
import { migrateOnStart } from './lib/db/migrateOnStart'
import { createDexieRepository } from './lib/db/dexieRepository'
import { getDb } from './lib/db/dexie'
import { setPreloadedLegacyView, toLegacyView } from './lib/db/toLegacyView'
import './index.css'

/**
 * 启动流程（Phase 8 / W1）
 *
 * ```
 * 1. 启动迁移：localStorage → IndexedDB（幂等）
 * 2. 迁移成功 → 开启只读模式，旧 UI 转为只读预览
 * 3. 渲染 App（1.0 界面，数据来自 2.0）
 * ```
 *
 * ## 为什么在渲染前 await
 *
 * 只读标记必须在 `App` 首次渲染前就位 —— 否则 `usePortfolio` 会先按可写模式
 * 挂载一次，可能出现「先写入再被拦」的窗口。
 *
 * ## 为什么不因为失败而白屏
 *
 * `migrateOnStart` 内部吞掉所有异常并返回状态。
 * 迁移失败时**不开启只读**，旧 UI 保持可写 —— 这是刻意的降级：
 * 宁可暂时维持 1.0 的行为，也不要让用户完全无法使用。
 */
async function bootstrap(): Promise<void> {
  try {
    // repo 与 db 必须是同一个数据库实例，否则迁移记录与业务数据会分裂到两处
    const db = getDb()
    const repo = createDexieRepository(db)
    const result = await migrateOnStart({ repo, db })

    /*
     * 只读模式下的读路径：
     * 把 IndexedDB 里的 2.0 数据投影成 1.0 视图并**同步**注入，
     * 让 `usePortfolio` 首帧就读到迁移后的数据（而不是 localStorage 的旧副本）。
     */
    if (result.readOnly) {
      const portfolio = await repo.loadPortfolio()
      setPreloadedLegacyView(toLegacyView(portfolio))
    }
  } catch (e) {
    // 迁移编排本身不应抛出；这里只是最后一道保险，绝不阻断渲染
    console.warn('[wealthcard] 启动迁移失败，将以 1.0 行为继续运行：', e)
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('#root 容器不存在')

  /*
   * W2 视图开关（Phase 8 / W2）
   *
   * `?w2=1` → 新版只读视图（首页 / 资产管理）
   * 缺省     → 1.0 旧界面（W1 的只读降级状态，保持不变）
   *
   * 替换旧 UI 属于 W3，因此这里用参数切换而不是直接接管。
   */
  const useW2 =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('w2') === '1'

  createRoot(container).render(
    <StrictMode>{useW2 ? <App2 /> : <App />}</StrictMode>,
  )
}

void bootstrap()
