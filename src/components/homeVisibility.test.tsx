// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultSettings as createDefaultStrategySettings,
  resolveStrategy,
} from '../lib/rebalance'
import { type AppSettings, createDefaultSettings } from '../lib/settings'
import type { Category, Portfolio } from '../types/asset'
import App from '../App'
import { makeDividends } from '../test/fixtures'
import SettingsSheet, { HomePage } from './SettingsSheet'
import StrategySettingsSheet from './StrategySettingsSheet'

const SETTINGS_KEY = 'asset-card-wallet/settings/v1'
const emptyPortfolio: Portfolio = { version: 2, categories: [], history: [] }

/** jsdom 不做布局，getBoundingClientRect 全是 0：按「每行 80px 依次向下」伪造几何 */
const fakeRect = (top: number, height: number): DOMRect =>
  ({ top, bottom: top + height, left: 0, right: 360, width: 360, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

const seedHome = (home: unknown) =>
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, home }))

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ *
 * 首页显示什么 / 顺序
 * ------------------------------------------------------------------ */
describe('首页默认显示什么', () => {
  it('默认只出现持仓总盈亏与数据管理，投资策略与走势都不出现', () => {
    render(<App />)
    expect(screen.getByText('持仓总盈亏')).toBeTruthy()
    expect(screen.getByText(/只持仓/)).toBeTruthy() // 0 持仓也显示 0
    expect(screen.getByText('成本合计', { exact: false })).toBeTruthy()
    expect(screen.getByText('资产分类')).toBeTruthy()
    expect(screen.getByText('数据管理')).toBeTruthy()
    expect(screen.queryByText(/再平衡建议/)).toBeNull()
    expect(screen.queryByText('走势')).toBeNull()
  })

  it('打开投资策略后才出现，位置由 order 决定', () => {
    seedHome({
      order: ['strategy', 'holdingsProfit'],
      visible: { strategy: true, holdingsProfit: true, trends: false },
    })
    render(<App />)
    const strategy = screen.getByText(/再平衡建议/)
    const profit = screen.getByText('持仓总盈亏')
    expect(strategy.compareDocumentPosition(profit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('把顺序反过来，渲染顺序也跟着反过来', () => {
    seedHome({
      order: ['holdingsProfit', 'strategy'],
      visible: { strategy: true, holdingsProfit: true, trends: false },
    })
    render(<App />)
    const strategy = screen.getByText(/再平衡建议/)
    const profit = screen.getByText('持仓总盈亏')
    expect(profit.compareDocumentPosition(strategy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('打开走势面板后才出现', () => {
    seedHome({
      order: ['holdingsProfit', 'trends'],
      visible: { strategy: false, holdingsProfit: true, trends: true },
    })
    render(<App />)
    expect(screen.getByText('走势')).toBeTruthy()
  })

  it('老数据没有 home 时沿用旧的 trends.enabled', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, trends: { enabled: true } }))
    render(<App />)
    expect(screen.getByText('走势')).toBeTruthy()
  })
})

/* ------------------------------------------------------------------ *
 * 「首页显示」设置页
 * ------------------------------------------------------------------ */
const noop = () => {}
const baseStrategySettings = createDefaultStrategySettings()

/** 设置里「投资策略」页需要的表单数据与回调 */
const strategyPanel = {
  settings: baseStrategySettings,
  strategy: resolveStrategy(baseStrategySettings),
  mapping: {},
  categories: [],
  categoryValues: {},
  onSelectStrategy: noop,
  onThresholdChange: noop,
  onIncludeLiabilitiesChange: noop,
  onSetMapping: noop,
  onResetMapping: noop,
  onAddCustomStrategy: () => resolveStrategy(baseStrategySettings),
  onUpdateCustomStrategy: noop,
  onRemoveCustomStrategy: noop,
}

function renderHome(overrides: Partial<AppSettings> = {}) {
  const onSetHomeVisible = vi.fn()
  const onSetHomeOrder = vi.fn()
  const onNudgeHomeBlock = vi.fn()
  render(
    <HomePage
      settings={{ ...createDefaultSettings(), ...overrides }}
      onSetHomeVisible={onSetHomeVisible}
      onSetHomeOrder={onSetHomeOrder}
      onNudgeHomeBlock={onNudgeHomeBlock}
    />,
  )
  return { onSetHomeVisible, onSetHomeOrder, onNudgeHomeBlock }
}

const rowIds = () =>
  screen.getAllByTestId(/^home-row-/).map((el) => el.getAttribute('data-testid'))

function layoutRows() {
  const list = screen.getByTestId('home-block-list')
  const rows = screen.getAllByTestId(/^home-row-/) as HTMLElement[]
  list.getBoundingClientRect = () => fakeRect(0, rows.length * 80)
  rows.forEach((el, i) => {
    el.getBoundingClientRect = () => fakeRect(i * 80, 80)
  })
  return rows
}

describe('首页显示设置页', () => {
  it('四个区块全部列出（包括隐藏的），默认顺序 持仓总盈亏 → 投资策略 → 走势 → 分红日历', () => {
    renderHome()
    expect(rowIds()).toEqual([
      'home-row-holdingsProfit',
      'home-row-strategy',
      'home-row-trends',
      'home-row-dividends',
    ])
    expect(screen.getByText('持仓总盈亏')).toBeTruthy()
    expect(screen.getByText('投资策略与再平衡')).toBeTruthy()
    expect(screen.getByText('走势面板')).toBeTruthy()
    expect(screen.getByText('分红日历')).toBeTruthy()
  })

  it('开关默认值：持仓总盈亏开，投资策略与走势关', () => {
    renderHome()
    expect(screen.getByTestId('home-toggle-holdingsProfit').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('home-toggle-strategy').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByTestId('home-toggle-trends').getAttribute('aria-checked')).toBe('false')
  })

  it('点开关会把新状态回调出去', () => {
    const { onSetHomeVisible } = renderHome()
    fireEvent.click(screen.getByTestId('home-toggle-strategy'))
    expect(onSetHomeVisible).toHaveBeenCalledWith('strategy', true)

    cleanup()
    const second = renderHome({
      home: {
        order: ['holdingsProfit', 'strategy', 'trends'],
        visible: { holdingsProfit: true, strategy: true, trends: false, dividends: false },
      },
    })
    fireEvent.click(screen.getByTestId('home-toggle-strategy'))
    expect(second.onSetHomeVisible).toHaveBeenCalledWith('strategy', false)
  })

  it('↑↓ 按钮回调方向正确，首行不能上移、末行不能下移', () => {
    const { onNudgeHomeBlock } = renderHome()
    fireEvent.click(screen.getByTestId('home-down-holdingsProfit'))
    expect(onNudgeHomeBlock).toHaveBeenCalledWith('holdingsProfit', 1)

    const up = screen.getByTestId('home-up-holdingsProfit') as HTMLButtonElement
    const down = screen.getByTestId('home-down-dividends') as HTMLButtonElement
    expect(up.disabled).toBe(true)
    expect(down.disabled).toBe(true)
    fireEvent.click(up)
    fireEvent.click(down)
    expect(onNudgeHomeBlock).toHaveBeenCalledTimes(1) // 禁用按钮不再触发
  })
})

/* ------------------------------------------------------------------ *
 * 拖拽排序（手势 + 长按 + 落位）
 * ------------------------------------------------------------------ */
describe('长按拖动排序', () => {
  it('长按后拖到下一格，提交新顺序', () => {
    vi.useFakeTimers()
    const { onSetHomeOrder } = renderHome()
    layoutRows()
    const grip = screen.getByTestId('home-drag-holdingsProfit')

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40 })
    act(() => {
      vi.advanceTimersByTime(220) // 越过 180ms 长按
    })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 140 }) // 越过第二行中线（120）
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 140 })

    expect(onSetHomeOrder).toHaveBeenCalledWith(['strategy', 'holdingsProfit', 'trends', 'dividends'])
  })

  it('一直拖到最后一格，顺序整体上移', () => {
    vi.useFakeTimers()
    const { onSetHomeOrder } = renderHome()
    layoutRows()
    const grip = screen.getByTestId('home-drag-holdingsProfit')

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40 })
    act(() => {
      vi.advanceTimersByTime(220)
    })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 300 }) // 越过第四行中线（280）→ 落到最后一格
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 300 })

    expect(onSetHomeOrder).toHaveBeenCalledWith(['strategy', 'trends', 'dividends', 'holdingsProfit'])
  })

  it('往上拖同样有效', () => {
    vi.useFakeTimers()
    const { onSetHomeOrder } = renderHome()
    layoutRows()
    const grip = screen.getByTestId('home-drag-trends')

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 200 })
    act(() => {
      vi.advanceTimersByTime(220)
    })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 }) // 越过第二行中线（120）
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 60 })

    expect(onSetHomeOrder).toHaveBeenCalledWith(['holdingsProfit', 'trends', 'strategy', 'dividends'])
  })

  it('长按拖拽时不会选中文字、也不会弹系统菜单（手机上的框选问题）', () => {
    renderHome()
    const list = screen.getByTestId('home-block-list')
    // 列表禁用文字选中
    expect(list.className).toContain('select-none')
    // 长按弹出的系统菜单被拦掉（fireEvent 返回 false 表示 preventDefault 已生效）
    expect(fireEvent.contextMenu(list)).toBe(false)
    // 指针按下时取消默认行为，浏览器不会开始选字
    const grip = screen.getByTestId('home-drag-holdingsProfit')
    expect(fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40 })).toBe(false)
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 40 })
  })

  it('没到长按时长就松手：不改顺序（只是普通点击）', () => {
    vi.useFakeTimers()
    const { onSetHomeOrder } = renderHome()
    layoutRows()
    const grip = screen.getByTestId('home-drag-holdingsProfit')

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 140 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 140 })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(onSetHomeOrder).not.toHaveBeenCalled()
  })

  it('长按之前滑动超过 8px 视为滚动，不会进入拖拽', () => {
    vi.useFakeTimers()
    const { onSetHomeOrder } = renderHome()
    layoutRows()
    const grip = screen.getByTestId('home-drag-holdingsProfit')

    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 62 }) // 22px，判定为滚动
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 200 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 200 })

    expect(onSetHomeOrder).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ *
 * 设置菜单入口与跳转
 * ------------------------------------------------------------------ */
describe('设置菜单', () => {
  const sheetProps = {
    open: true,
    settings: createDefaultSettings(),
    portfolio: emptyPortfolio,
    candidates: [],
    onClose: noop,
    onSetFundDefault: noop,
    onSetFundingSource: noop,
    onSetTrends: noop,
    onSetHomeVisible: noop,
    onSetHomeOrder: noop,
    onNudgeHomeBlock: noop,
    strategyPanel,
    dividends: makeDividends(),
    dividendSettings: createDefaultSettings().dividends,
    onSetDividendSettings: noop,
    rates: null,
    notify: noop,
    onSetFixed: noop,
    onUpsertSalary: noop,
    onRemoveSalary: noop,
    onApplySalary: () => ({ ok: true, message: '' }),
  }

  it('点「首页显示」进入排序页；返回后点「投资策略」进入设置内的策略页', () => {
    render(<SettingsSheet {...sheetProps} />)

    fireEvent.click(screen.getByTestId('settings-menu-home'))
    expect(screen.getByTestId('home-block-list')).toBeTruthy()

    fireEvent.click(screen.getByTestId('settings-back'))
    fireEvent.click(screen.getByTestId('settings-menu-strategy'))

    // 关键：仍然在设置面板里（有返回箭头），内容是策略表单，而不是又叠一层弹窗
    expect(screen.getByTestId('settings-back')).toBeTruthy()
    expect(screen.getByText('策略与参数')).toBeTruthy()
    expect(screen.getByText('资产映射')).toBeTruthy()
    expect(screen.getByText('策略权重、分类映射与再平衡阈值')).toBeTruthy()

    // 返回箭头回到设置菜单
    fireEvent.click(screen.getByTestId('settings-back'))
    expect(screen.getByTestId('settings-menu')).toBeTruthy()
  })

  it('首页策略卡片的弹层仍然正常（抽出表单后两条路都能用）', () => {
    const { container } = render(
      <StrategySettingsSheet open onClose={noop} defaultMapping={{}} {...strategyPanel} />,
    )
    expect(screen.getByText('策略配置')).toBeTruthy()
    expect(screen.getByText('策略与参数')).toBeTruthy()
    expect(container.textContent).toContain('资产映射')

    cleanup()
    const closed = render(
      <StrategySettingsSheet open={false} onClose={noop} defaultMapping={{}} {...strategyPanel} />,
    )
    expect(closed.container.innerHTML).toBe('')
  })

  it('薪资页的「写入哪个账户」用新选择框：余额 0 的现金条目也能选（回归）', () => {
    const cash: Category = {
      id: 'cat_cash',
      name: '现金与固定资产',
      subtitle: '',
      icon: 'wallet',
      color: 'x',
      items: [{ id: '招行活期', kind: 'amount', name: '招行活期', amount: 0 }],
    }
    const settings = {
      ...sheetProps.settings,
      salary: { ...sheetProps.settings.salary, fixed: { ...sheetProps.settings.salary.fixed, enabled: true } },
    }
    render(
      <SettingsSheet
        {...sheetProps}
        settings={settings}
        portfolio={{ version: 2, categories: [cash], history: [] }}
      />,
    )
    fireEvent.click(screen.getByTestId('settings-menu-salary'))
    expect(screen.getByTestId('salary-fixed-target')).toBeTruthy()
    expect(screen.getByRole('option', { name: /招行活期/ })).toBeTruthy()
  })

  it('走势图页不再有显示开关，改为指向「首页显示」', () => {
    render(<SettingsSheet {...sheetProps} />)
    fireEvent.click(screen.getByTestId('settings-menu-trends'))
    expect(screen.queryByTestId('trends-toggle')).toBeNull()
    expect(screen.getByText(/统一在「首页显示」里设置/)).toBeTruthy()
  })
})
