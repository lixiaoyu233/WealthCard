// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HoldingImportSheet from './HoldingImportSheet'

const TEXT = [
  '# 校验：共 2 条，字段完整 2 条',
  '类型=基金 代码=161725 名称=招商中证白酒 份额=12000 成本单价=1.2345 备注=支付宝',
  '类型=股票 市场=A股 代码=600519 名称=贵州茅台 份额=100 成本总额=150000',
  '这一行是废话',
].join('\n')

const renderSheet = (
  opts: {
    existing?: Array<{ id: string; code: string; market?: 'cn' | 'ashare' | 'hk' | 'us'; shares?: number; costNav?: number }>
    noCategory?: boolean
    /** 打开自动补全（默认关，避免测试联网） */
    autoEnrich?: boolean
    enrichImpl?: (h: never, o?: never) => Promise<never>
  } = {},
) => {
  const onImport = vi.fn()
  const notify = vi.fn()
  const onClose = vi.fn()
  render(
    <HoldingImportSheet
      open
      onClose={onClose}
      defaultType="fund"
      targetCategory={(type) =>
        opts.noCategory ? undefined : type === 'fund' ? { id: 'cat_fund', name: '基金' } : { id: 'cat_stock', name: '股票' }
      }
      existing={opts.existing ?? []}
      onImport={onImport}
      notify={notify}
      autoEnrich={opts.autoEnrich ?? false}
      enrichImpl={opts.enrichImpl as never}
    />,
  )
  return { onImport, notify, onClose }
}

const paste = (text: string) => fireEvent.change(screen.getByTestId('holding-import-text'), { target: { value: text } })
const parse = () => fireEvent.click(screen.getByTestId('holding-import-parse'))

afterEach(cleanup)

describe('批量导入弹窗', () => {
  it('弹窗层级比分类详情高一层（否则会被详情盖住）', () => {
    renderSheet()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.className).toContain('z-[60]')
  })

  it('解析后显示预览、汇总与错误行；注释单独列出', () => {
    renderSheet()
    paste(TEXT)
    parse()

    // 3 行正文：1 行干净、1 行有提示（成本总额换算）、1 行错误；注释不计入 total
    expect(screen.getByTestId('holding-import-summary').textContent).toContain('3 条：可导入 1 · 有提示 1 · 错误 1')
    expect(screen.getByTestId('holding-import-row-2')).toBeTruthy()
    expect(screen.getByTestId('holding-import-row-3')).toBeTruthy()
    expect(screen.getByTestId('holding-import-error-4').textContent).toContain('第 4 行')
    expect(screen.getByTestId('holding-import-notes').textContent).toContain('校验：共 2 条')
    // 成本总额那行给出换算提示
    expect(screen.getByTestId('holding-import-row-3').textContent).toContain('成本总额 ÷ 份额')
  })

  it('导入选中的行（带勾选与就地修改）', () => {
    const { onImport } = renderSheet()
    paste(TEXT)
    parse()

    // 就地改份额
    fireEvent.change(screen.getByTestId('holding-import-shares-2'), { target: { value: '10000' } })
    fireEvent.click(screen.getByTestId('holding-import-submit'))

    expect(onImport).toHaveBeenCalledTimes(1)
    const rows = onImport.mock.calls[0][0]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ type: 'fund', code: '161725', shares: 10000, costNav: 1.2345 })
    expect(rows[1]).toMatchObject({ type: 'stock', market: 'ashare', code: '600519', costNav: 1500 })
  })

  it('取消勾选的行不导入', () => {
    const { onImport } = renderSheet()
    paste(TEXT)
    parse()
    fireEvent.click(screen.getByTestId('holding-import-check-3'))
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    const rows = onImport.mock.calls[0][0]
    expect(rows).toHaveLength(1)
    expect(rows[0].code).toBe('161725')
  })

  it('已存在的同代码默认不勾选，可手动打开「已存在的也导入」', () => {
    const { onImport } = renderSheet({ existing: [{ id: 'e1', code: '600519', market: 'ashare' }] })
    paste(TEXT)
    parse()

    expect(screen.getByTestId('holding-import-dup-3')).toBeTruthy()
    expect((screen.getByTestId('holding-import-check-3') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('holding-import-check-2') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport.mock.calls[0][0]).toHaveLength(1)

    fireEvent.click(screen.getByTestId('holding-import-allow-dup'))
    expect((screen.getByTestId('holding-import-check-3') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport.mock.calls[1][0]).toHaveLength(2)
  })

  it('份额被改成 0 时拒绝导入并提示', () => {
    const { onImport, notify } = renderSheet()
    paste(TEXT)
    parse()
    fireEvent.change(screen.getByTestId('holding-import-shares-2'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('份额必须大于 0'), 'error')
  })

  it('目标分类不存在时给出明确提示', () => {
    const { onImport, notify } = renderSheet({ noCategory: true })
    paste(TEXT)
    parse()
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('找不到要导入的分类'), 'error')
  })

  it('复制提示词：写进剪贴板并提示', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const { notify } = renderSheet()
    fireEvent.click(screen.getByTestId('holding-import-copy-prompt'))
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('持仓截图识别助手')
    expect(writeText.mock.calls[0][0]).toContain('1 手 = 100 股')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('提示词已复制'), 'success')
  })

  it('查看提示词：展开后能看到完整提示词', () => {
    renderSheet()
    fireEvent.click(screen.getByText('查看提示词'))
    const box = screen.getByTestId('holding-import-prompt') as HTMLTextAreaElement
    expect(box.value).toContain('【必需信息】')
    expect(box.value).toContain('# 校验：共 N 条')
  })

  it('没解析出东西时提示检查格式，不显示预览', () => {
    const { notify } = renderSheet()
    paste('随便写点什么')
    parse()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('解析失败'), 'error')
    expect(screen.queryByTestId('holding-import-row-1')).toBeNull()
  })
})


describe('金额模式（只有名称 + 金额的截图）', () => {
  it('预览显示「按金额」标签与金额输入框，导入时只校验金额', () => {
    const { onImport } = renderSheet()
    paste('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27')
    parse()
    expect(screen.getByTestId('holding-import-row-1').textContent).toContain('按金额')
    expect((screen.getByTestId('holding-import-amount-1') as HTMLInputElement).value).toBe('10.27')
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0][0][0]).toMatchObject({ mode: 'amount', amount: 10.27, shares: 0 })
  })

  it('金额改成 0 时拦下并提示', () => {
    const { onImport, notify } = renderSheet()
    paste('类型=基金 名称=某某基金 金额=10')
    parse()
    fireEvent.change(screen.getByTestId('holding-import-amount-1'), { target: { value: '0' } })
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('金额必须大于 0'), 'error')
  })
})


describe('自动补全（名称 → 代码 → 净值 → 份额）', () => {
  const enrichStub = (over: Record<string, unknown> = {}) =>
    async () => ({
      code: '016452',
      officialName: '南方纳斯达克100指数发起(QDII)A',
      ftype: '指数型-海外股票',
      nav: 1.25,
      navDate: '2026-10-05',
      shares: 8.216,
      costNav: 1.2173,
      sources: { code: 'name-search', shares: 'derived-nav', cost: 'derived-profit' },
      candidates: [
        { code: '016452', name: '南方纳斯达克100指数发起(QDII)A' },
        { code: '016453', name: '南方纳斯达克100指数发起(QDII)C' },
      ],
      notes: ['份额按 2026-10-05 净值 1.25 由市值推算（8.22 份）'],
      ...over,
    }) as never

  it('补全结果与来源都显示出来（代码/份额/成本）', async () => {
    renderSheet({ autoEnrich: true, enrichImpl: enrichStub() })
    paste('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27 持仓收益=0.27')
    parse()
    const box = await screen.findByTestId('holding-import-enriched-1')
    expect(box.textContent).toContain('016452')
    expect(box.textContent).toContain('按名称搜到')
    expect(box.textContent).toContain('由市值推算')
    expect(box.textContent).toContain('由持仓收益反推')
    expect(box.textContent).toContain('2026-10-05')
  })

  it('补全到份额后，导入时从「按金额」升级成持仓（能算盈亏）', async () => {
    const { onImport } = renderSheet({ autoEnrich: true, enrichImpl: enrichStub() })
    paste('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27 持仓收益=0.27')
    parse()
    await screen.findByTestId('holding-import-enriched-1')
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    const row = onImport.mock.calls[0][0][0]
    expect(row).toMatchObject({
      mode: 'holding',
      code: '016452',
      shares: 8.216,
      costNav: 1.2173,
      // 关键：补全到的当前净值要一起带上，否则市值会退回成本、盈亏恒为 0
      price: 1.25,
    })
    expect(onImport.mock.calls[0][0]).toHaveLength(1)
  })

  it('有多个份额（A/C）时给下拉可以改选', async () => {
    renderSheet({ autoEnrich: true, enrichImpl: enrichStub() })
    paste('类型=基金 名称=南方纳斯达克100指数发起 金额=10.27')
    parse()
    await screen.findByTestId('holding-import-enriched-1')
    const select = screen.getByTestId('holding-import-candidate-1') as HTMLSelectElement
    // 第一项是占位「请选择」（不够像时也用它让用户自己选）
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', '016452', '016453'])
  })

  it('补全失败（没有代码/份额）时不报错，仍可按金额导入', async () => {
    const { onImport, notify } = renderSheet({
      autoEnrich: true,
      enrichImpl: (async () => ({
        sources: {},
        candidates: [],
        notes: ['没搜到「某某基金」的代码，可手动填或保持按金额记账'],
      })) as never,
    })
    paste('类型=基金 名称=某某基金 金额=10')
    parse()
    await screen.findByText(/没搜到/)
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport.mock.calls[0][0][0]).toMatchObject({ mode: 'amount', amount: 10 })
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining('失败'), 'error')
  })
})


describe('重复检测（修复：代码是补全出来的，以前永远判不出重复）', () => {
  const enrichStub = (async () => ({
    code: '016452',
    officialName: '南方纳斯达克100指数发起(QDII)A',
    nav: 2.3393,
    navDate: '2026-09-29',
    shares: 4.39,
    costNav: 2.2778,
    sources: { code: 'name-search', shares: 'derived-nav', cost: 'derived-profit' },
    candidates: [],
    notes: [],
  })) as never

  const existing = [
    { id: 'e1', code: '016452', market: 'cn' as const, name: '南方纳斯达克100指数发起(QDII)A', shares: 10, costNav: 2 },
  ]

  const pasteOnce = () => {
    paste('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27 持仓收益=0.27')
    parse()
  }

  it('补全拿到代码后，才判定「已存在」', async () => {
    renderSheet({ autoEnrich: true, enrichImpl: enrichStub, existing })
    pasteOnce()
    expect(await screen.findByTestId('holding-import-dup-1')).toBeTruthy()
    expect(screen.getByTestId('holding-import-dup-1').textContent).toContain('已存在')
  })

  it('默认跳过；选「新建一条」就能导入第二条', async () => {
    const { onImport } = renderSheet({ autoEnrich: true, enrichImpl: enrichStub, existing })
    pasteOnce()
    await screen.findByTestId('holding-import-dup-1')
    // 默认跳过 → 没东西可导
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).not.toHaveBeenCalled()
    // 显式选「新建一条」
    fireEvent.click(screen.getByTestId('holding-import-dup-new-1'))
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).toHaveBeenCalledTimes(1)
    const row = onImport.mock.calls[0][0][0]
    expect(row.mergeInto).toBeUndefined()
    expect(row).toMatchObject({ mode: 'holding', code: '016452', shares: 4.39, costNav: 2.2778 })
  })

  it('右上开关：一键把所有重复行改成「新建一条」', async () => {
    const { onImport } = renderSheet({ autoEnrich: true, enrichImpl: enrichStub, existing })
    pasteOnce()
    await screen.findByTestId('holding-import-dup-1')
    const toggle = screen.getByTestId('holding-import-allow-dup')
    fireEvent.click(toggle)
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0][0]).toHaveLength(1)
  })

  it('选「合并到已有」→ 带上 mergeInto（份额相加 + 成本加权）', async () => {
    const { onImport } = renderSheet({ autoEnrich: true, enrichImpl: enrichStub, existing })
    pasteOnce()
    await screen.findByTestId('holding-import-dup-1')
    fireEvent.click(screen.getByTestId('holding-import-dup-merge-1'))
    fireEvent.click(screen.getByTestId('holding-import-submit'))
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onImport.mock.calls[0][0][0]).toMatchObject({
      mergeInto: 'e1',
      mode: 'holding',
      code: '016452',
      shares: 4.39,
      costNav: 2.2778,
    })
  })
})
