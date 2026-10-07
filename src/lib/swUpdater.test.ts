import { describe, expect, it, vi } from 'vitest'
import {
  applyWaitingUpdate,
  checkForUpdate,
  fetchRemoteBuildId,
  registerServiceWorker,
  resolveUpdateDecision,
  shouldRegister,
  watchRegistration,
  type ServiceWorkerLike,
  type SwContainerLike,
  type SwRegistrationLike,
} from './swUpdater'

/* ---------------- 极简替身 ---------------- */

class FakeWorker implements ServiceWorkerLike {
  state = 'installing'
  messages: unknown[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  postMessage(message: unknown) {
    this.messages.push(message)
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({})
  }
}

class FakeRegistration implements SwRegistrationLike {
  waiting: FakeWorker | null = null
  installing: FakeWorker | null = null
  updateCalls = 0
  updateError?: Error
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({})
  }
  async update() {
    this.updateCalls += 1
    if (this.updateError) throw this.updateError
  }
}

class FakeContainer implements SwContainerLike {
  controller: unknown = null
  registerCalls: string[] = []
  registerError?: Error
  registration = new FakeRegistration()
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  async register(url: string) {
    this.registerCalls.push(url)
    if (this.registerError) throw this.registerError
    return this.registration
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }
  emit(type: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({})
  }
}

const noop = () => {}

/* ---------------- 用例 ---------------- */

describe('什么时候注册 SW', () => {
  it('开发环境不注册（否则热更新会被缓存干扰）', () => {
    expect(shouldRegister({ isDev: true, container: new FakeContainer() })).toBe(false)
  })

  it('浏览器不支持（隐私模式等）不注册', () => {
    expect(shouldRegister({ isDev: false, container: undefined })).toBe(false)
  })

  it('生产 + 支持 → 注册', () => {
    expect(shouldRegister({ isDev: false, container: new FakeContainer() })).toBe(true)
  })
})

describe('新版本检测', () => {
  const setup = () => {
    const container = new FakeContainer()
    const registration = new FakeRegistration()
    const onUpdateReady = vi.fn()
    const reload = vi.fn()
    watchRegistration(registration, container, { onUpdateReady }, reload)
    return { container, registration, onUpdateReady, reload }
  }

  it('首次安装（还没有 controller）不提示「有新版本」', () => {
    const { container, registration, onUpdateReady } = setup()
    const worker = new FakeWorker()
    registration.installing = worker
    registration.emit('updatefound')
    worker.state = 'installed'
    worker.emit('statechange')
    expect(container.controller).toBeNull()
    expect(onUpdateReady).not.toHaveBeenCalled()
  })

  it('已有 controller 时装好新 SW → 提示更新', () => {
    const { container, registration, onUpdateReady } = setup()
    container.controller = {} // 说明之前就有版本在跑
    const worker = new FakeWorker()
    registration.installing = worker
    registration.emit('updatefound')
    worker.state = 'installed'
    worker.emit('statechange')
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('上次装好没应用就关了页面 → 这次打开直接提示', () => {
    const container = new FakeContainer()
    container.controller = {}
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker()
    const onUpdateReady = vi.fn()
    watchRegistration(registration, container, { onUpdateReady }, noop)
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('状态不是 installed 时不提示', () => {
    const { container, registration, onUpdateReady } = setup()
    container.controller = {}
    const worker = new FakeWorker()
    registration.installing = worker
    registration.emit('updatefound')
    worker.state = 'installing'
    worker.emit('statechange')
    expect(onUpdateReady).not.toHaveBeenCalled()
  })

  it('新 SW 接管后刷新，且只刷一次（避免刷新循环）', () => {
    const { container, reload } = setup()
    container.emit('controllerchange')
    container.emit('controllerchange')
    container.emit('controllerchange')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('「有新版本」只看版本号，不看 SW 状态（踩过的坑）', () => {
  const running = '2026-10-07T09:25:19.093Z'

  it('版本相同 + SW 停在 waiting → 不提示更新，改为静默接管', () => {
    const d = resolveUpdateDecision({ runningId: running, remoteId: running, waiting: true })
    expect(d.updateReady).toBe(false)
    expect(d.shouldTakeOver).toBe(true)
  })

  it('版本不同 + waiting → 提示更新（不要去接管，要让用户点）', () => {
    const d = resolveUpdateDecision({
      runningId: running,
      remoteId: '2026-10-07T09:26:41.500Z',
      waiting: true,
    })
    expect(d.updateReady).toBe(true)
    expect(d.shouldTakeOver).toBe(false)
  })

  it('版本不同但 SW 还没装好（没 waiting）→ 也提示（点更新时会触发检查）', () => {
    const d = resolveUpdateDecision({ runningId: running, remoteId: '2026-10-07T09:26:41.500Z', waiting: false })
    expect(d.updateReady).toBe(true)
  })

  it('读不到线上版本（离线）→ 不提示、不接管', () => {
    const d = resolveUpdateDecision({ runningId: running, remoteId: undefined, waiting: true })
    expect(d.updateReady).toBe(false)
    expect(d.shouldTakeOver).toBe(false)
  })
})

describe('应用更新与检查更新', () => {
  it('有 waiting → 发 SKIP_WAITING', () => {
    const registration = new FakeRegistration()
    const worker = new FakeWorker()
    registration.waiting = worker
    expect(applyWaitingUpdate(registration)).toBe(true)
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }])
  })

  it('没有 waiting → 不假装成功', () => {
    expect(applyWaitingUpdate(new FakeRegistration())).toBe(false)
  })

  it('检查更新调用 registration.update()，网络异常时静默', async () => {
    const registration = new FakeRegistration()
    await checkForUpdate(registration)
    expect(registration.updateCalls).toBe(1)
    registration.updateError = new Error('offline')
    await expect(checkForUpdate(registration)).resolves.toBeUndefined()
  })
})

describe('读线上版本号', () => {
  const okResponse = (text: string) =>
    ({ ok: true, text: async () => text }) as unknown as Response

  it('从线上 sw.js 里解析出 BUILD_ID', async () => {
    const fetchImpl = vi.fn(async () => okResponse("const BUILD_ID = '2026-10-07T09:09:28.349Z'")) as unknown as typeof fetch
    expect(await fetchRemoteBuildId(fetchImpl)).toBe('2026-10-07T09:09:28.349Z')
  })

  it('HTTP 失败 / 抛错 → undefined（不误报有新版）', async () => {
    const bad = vi.fn(async () => ({ ok: false, text: async () => '' }) as unknown as Response) as unknown as typeof fetch
    expect(await fetchRemoteBuildId(bad)).toBeUndefined()
    const boom = vi.fn(async () => {
      throw new Error('network')
    }) as unknown as typeof fetch
    expect(await fetchRemoteBuildId(boom)).toBeUndefined()
  })
})

describe('注册入口', () => {
  it('开发环境：不调用 register，返回 undefined', async () => {
    const container = new FakeContainer()
    const res = await registerServiceWorker({ container, isDev: true })
    expect(res).toBeUndefined()
    expect(container.registerCalls).toEqual([])
  })

  it('生产：注册并把更新监听接上', async () => {
    const container = new FakeContainer()
    container.controller = {}
    const onUpdateReady = vi.fn()
    const res = await registerServiceWorker({ container, isDev: false, onUpdateReady, reload: noop })
    expect(res).toBe(container.registration)
    expect(container.registerCalls).toEqual(['./sw.js'])

    const worker = new FakeWorker()
    container.registration.installing = worker
    container.registration.emit('updatefound')
    worker.state = 'installed'
    worker.emit('statechange')
    expect(onUpdateReady).toHaveBeenCalledTimes(1)
  })

  it('注册失败（不支持 / 隐私模式）不影响使用', async () => {
    const container = new FakeContainer()
    container.registerError = new Error('ServiceWorker is not supported')
    expect(await registerServiceWorker({ container, isDev: false })).toBeUndefined()
  })
})
