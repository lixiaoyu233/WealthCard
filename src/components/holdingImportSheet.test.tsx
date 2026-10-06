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

const renderSheet = (opts: { existing?: Array<{ code: string; market?: 'cn' | 'ashare' | 'hk' | 'us' }>; noCategory?: boolean } = {}) => {
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
    const { onImport } = renderSheet({ existing: [{ code: '600519', market: 'ashare' }] })
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
