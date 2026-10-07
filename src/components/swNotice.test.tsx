// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SwNotice from './SwNotice'

const base = {
  runningTime: '10-07 17:09',
  onUpdate: () => {},
}

afterEach(cleanup)

describe('顶部缓存版本提示', () => {
  it('没有新版：显示当前缓存时间 + 已是最新', () => {
    render(<SwNotice {...base} updateReady={false} />)
    const notice = screen.getByTestId('sw-notice')
    expect(notice.getAttribute('data-update-ready')).toBe('false')
    expect(notice.textContent).toContain('缓存版本')
    expect(notice.textContent).toContain('10-07 17:09')
    expect(notice.textContent).toContain('已是最新')
    expect(screen.queryByTestId('sw-update')).toBeNull()
  })

  it('有新版本：显示新旧时间对比 + 可点按钮', () => {
    render(<SwNotice {...base} updateReady remoteTime="10-07 18:20" />)
    expect(screen.getByTestId('sw-notice').getAttribute('data-update-ready')).toBe('true')
    expect(screen.getByTestId('sw-notice').textContent).toContain('10-07 17:09')
    expect(screen.getByTestId('sw-notice').textContent).toContain('10-07 18:20')
    expect(screen.getByTestId('sw-update').textContent).toContain('点此更新')
  })

  it('点「点此更新」→ 触发回调', () => {
    const onUpdate = vi.fn()
    render(<SwNotice {...base} updateReady remoteTime="10-07 18:20" onUpdate={onUpdate} />)
    fireEvent.click(screen.getByTestId('sw-update'))
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('更新中：按钮禁用 + 文案变成「更新中…」（点击状态变化）', () => {
    render(<SwNotice {...base} updateReady updating remoteTime="10-07 18:20" />)
    const btn = screen.getByTestId('sw-update') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('更新中…')
    expect(btn.textContent).not.toContain('点此更新')
  })

  it('只有能点的才是按钮样式：「已是最新」是纯文字，「检查更新/点此更新」是药丸', () => {
    const { rerender } = render(<SwNotice {...base} updateReady={false} onCheck={() => {}} />)
    // 不能点的状态绝不能长成按钮（药丸 = 可点，是这套 UI 的约定）
    expect(screen.getByTestId('sw-latest').className).not.toContain('chip')
    expect(screen.getByTestId('sw-latest').tagName).toBe('SPAN')
    expect(screen.getByTestId('sw-check').className).toContain('chip-button')
    expect(screen.getByTestId('sw-check').tagName).toBe('BUTTON')

    rerender(<SwNotice {...base} updateReady remoteTime="10-07 18:20" />)
    expect(screen.getByTestId('sw-update').className).toContain('chip-update')
    // 禁用态必须由样式类保证，而不是只靠 disabled 属性
    expect(screen.getByTestId('sw-update').className).not.toContain('disabled:pointer-events-none')
  })

  it('「检查更新」：可点，检查中禁用并显示「检查中…」', () => {
    const onCheck = vi.fn()
    const { rerender } = render(<SwNotice {...base} updateReady={false} onCheck={onCheck} />)
    fireEvent.click(screen.getByTestId('sw-check'))
    expect(onCheck).toHaveBeenCalledTimes(1)

    rerender(<SwNotice {...base} updateReady={false} onCheck={onCheck} checking />)
    const btn = screen.getByTestId('sw-check') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toContain('检查中…')
  })
})
