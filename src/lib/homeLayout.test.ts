import { describe, expect, it } from 'vitest'
import { arrayMove, dragShifts, dropIndexFromDrag, type RowBox } from './homeLayout'

/** 三行、每行高 60：中线分别在 30 / 90 / 150 */
const boxes: RowBox[] = [
  { top: 0, height: 60 },
  { top: 60, height: 60 },
  { top: 120, height: 60 },
]

describe('arrayMove', () => {
  it('把元素移到目标位置', () => {
    expect(arrayMove(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(arrayMove(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('原地不动或越界时原样返回', () => {
    const list = ['a', 'b', 'c']
    expect(arrayMove(list, 1, 1)).toBe(list)
    expect(arrayMove(list, -1, 1)).toBe(list)
    expect(arrayMove(list, 0, 5)).toBe(list)
  })
})

describe('dropIndexFromDrag：越过中线才交换', () => {
  it('往下：越过下一行中线才换位', () => {
    expect(dropIndexFromDrag(boxes, 0, 59)).toBe(0) // 中心 89，未过第 2 行中线 90
    expect(dropIndexFromDrag(boxes, 0, 60)).toBe(0) // 正好压线也算没越过
    expect(dropIndexFromDrag(boxes, 0, 61)).toBe(1)
    expect(dropIndexFromDrag(boxes, 0, 119)).toBe(1) // 未过第 3 行中线 150
    expect(dropIndexFromDrag(boxes, 0, 121)).toBe(2)
  })

  it('往上：对称', () => {
    expect(dropIndexFromDrag(boxes, 2, -59)).toBe(2)
    expect(dropIndexFromDrag(boxes, 2, -61)).toBe(1)
    expect(dropIndexFromDrag(boxes, 1, -61)).toBe(0)
  })

  it('空列表或非法起点不崩', () => {
    expect(dropIndexFromDrag([], 0, 100)).toBe(0)
    expect(dropIndexFromDrag(boxes, 9, 100)).toBe(9)
  })
})

describe('dragShifts：让位位移', () => {
  it('往下拖：中间的行整体上移一个行高', () => {
    expect(dragShifts(boxes, 0, 2)).toEqual([0, -60, -60])
    expect(dragShifts(boxes, 0, 1)).toEqual([0, -60, 0])
  })

  it('往上拖：中间的行整体下移一个行高', () => {
    expect(dragShifts(boxes, 2, 0)).toEqual([60, 60, 0])
    expect(dragShifts(boxes, 1, 0)).toEqual([60, 0, 0])
  })

  it('没有跨行时谁都不动', () => {
    expect(dragShifts(boxes, 1, 1)).toEqual([0, 0, 0])
  })
})
