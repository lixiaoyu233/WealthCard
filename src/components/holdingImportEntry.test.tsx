// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetItem, Category } from '../types/asset'
import DetailSheet from './DetailSheet'

const noop = () => {}

const cat = (over: Partial<Category> & { id: string; name: string }): Category => ({
  subtitle: '',
  icon: 'x',
  color: 'x',
  items: [],
  ...over,
})

const fundItem: AssetItem = { id: 'f1', kind: 'fund', name: '招商白酒', code: '161725', shares: 100, costNav: 1.2 }

const renderDetail = (category: Category) => {
  const onOpenImport = vi.fn()
  render(
    <DetailSheet
      category={category}
      onClose={noop}
      onAddItem={noop}
      onUpdateItem={noop}
      onRemoveItem={noop}
      onUpdateCategory={noop}
      onRemoveCategory={noop}
      onMoveCategory={noop}
      onRefresh={noop}
      onEditCategory={noop}
      onOpenImport={onOpenImport}
    />,
  )
  return { onOpenImport }
}

afterEach(cleanup)

describe('批量导入入口显示在哪些分类', () => {
  it('股票分类（defaultKind 是 amount）也要有 —— 之前只有基金有', () => {
    renderDetail(cat({ id: 'cat_stock', name: '股票', defaultKind: 'amount' }))
    expect(screen.getByTestId('open-holding-import')).toBeTruthy()
  })

  it('基金分类（defaultKind=fund）有', () => {
    renderDetail(cat({ id: 'cat_fund', name: '基金', defaultKind: 'fund' }))
    expect(screen.getByTestId('open-holding-import')).toBeTruthy()
  })

  it('用户自建的「基金」「股票」分类也有（靠名字识别）', () => {
    renderDetail(cat({ id: 'c1', name: '我的基金' }))
    expect(screen.getByTestId('open-holding-import')).toBeTruthy()
    cleanup()
    renderDetail(cat({ id: 'c2', name: '港股股票' }))
    expect(screen.getByTestId('open-holding-import')).toBeTruthy()
  })

  it('已经有基金条目的分类也有', () => {
    renderDetail(cat({ id: 'c3', name: '理财', items: [fundItem] }))
    expect(screen.getByTestId('open-holding-import')).toBeTruthy()
  })

  it('黄金 / 负债 / 现金这些分类不该出现导入入口', () => {
    for (const c of [
      cat({ id: 'cat_gold', name: '黄金', defaultKind: 'gold' }),
      cat({ id: 'cat_debt', name: '负债', isLiability: true }),
      cat({ id: 'cat_cash', name: '现金与固定资产' }),
    ]) {
      cleanup()
      renderDetail(c)
      expect(screen.queryByTestId('open-holding-import')).toBeNull()
    }
  })
})
