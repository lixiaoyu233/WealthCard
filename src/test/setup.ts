/**
 * 测试环境补丁。
 *
 * vitest 默认跑在 node 环境（纯函数用例快）；组件用例在文件头写
 * `// @vitest-environment jsdom` 切到 jsdom。jsdom 缺几个浏览器 API，
 * 这里补上最小的替身，避免第三方组件（recharts / 指针手势）在测试里直接抛错。
 */

// recharts 的 ResponsiveContainer 需要它来决定尺寸
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub
}

// jsdom 没有 PointerEvent，而 React 的 onPointerDown/Move/Up 需要它
if (typeof window !== 'undefined' && !('PointerEvent' in window)) {
  class PointerEventStub extends MouseEvent {
    pointerId: number
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventStub
}

// 指针捕获在 jsdom 里没有实现：业务代码已 try/catch，这里给个空实现更贴近真机
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
}
