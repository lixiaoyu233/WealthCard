/**
 * 首页区块排序的纯计算：拖拽与 ↑↓ 按钮共用。
 *
 * 只做数学，不碰 DOM —— 元素测量与动画在 SettingsSheet 里，
 * 这样「拖到第几位」「谁该让位多少」这两件事都能被单测覆盖。
 */

/** 一行在列表中的位置（相对列表顶部，px） */
export interface RowBox {
  top: number
  height: number
}

/** 数组换位，越界或原地不动时原样返回 */
/**
 * 顶部「当前策略 · 偏离度」那一行的开关：
 * 首页把「投资策略」区块关掉后，这一行就不再显示。
 */
export function strategyStatusFor<T extends { text: string; level: string }>(
  strategyVisible: boolean,
  status: T,
): T | undefined {
  return strategyVisible ? status : undefined
}

export function arrayMove<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * 拖动中的行中心落在哪一格。
 * 判定用「另一行的中线」：越过中线才交换，避免手指稍微一动就来回跳。
 */
export function dropIndexFromDrag(boxes: RowBox[], from: number, deltaY: number): number {
  const src = boxes[from]
  if (!src || boxes.length === 0) return from
  const center = src.top + src.height / 2 + deltaY
  const ownCenter = src.top + src.height / 2

  let target = from
  if (center < ownCenter) {
    // 往上拖：找出最靠上、其中线仍在手指下方的那一行
    for (let i = from - 1; i >= 0; i--) {
      if (center < boxes[i].top + boxes[i].height / 2) target = i
      else break
    }
  } else {
    for (let i = from + 1; i < boxes.length; i++) {
      if (center > boxes[i].top + boxes[i].height / 2) target = i
      else break
    }
  }
  return target
}

/** 让位位移：拖拽经过的那几行整体上移/下移一个被拖行的高度 */
export function dragShifts(boxes: RowBox[], from: number, target: number): number[] {
  const shifts = boxes.map(() => 0)
  const src = boxes[from]
  if (!src) return shifts
  if (target > from) {
    for (let i = from + 1; i <= target; i++) shifts[i] = -src.height
  } else if (target < from) {
    for (let i = target; i < from; i++) shifts[i] = src.height
  }
  return shifts
}
