import { beforeEach, describe, expect, it } from 'vitest'
import type { Portfolio } from '../types/asset'
import { createDefaultCategories, mergeDefaultCategories } from './defaults'
import {
  CATEGORY_INTRO_KEY,
  STORAGE_KEY,
  clearPortfolio,
  loadPortfolio,
  normalizePortfolio,
  savePortfolio,
} from './storage'

/* ------------------------------------------------------------------ *
 * node 环境没有 window：装一个内存版 localStorage 替身
 * ------------------------------------------------------------------ */
const mem = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    get length() {
      return mem.size
    },
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
  },
}

const CATEGORY_IDS = ['cat_cash', 'cat_stock', 'cat_fund', 'cat_gold', 'cat_bond', 'cat_debt', 'cat_insurance']

/** 用给定 id 拼一份真实结构的组合数据 */
function portfolioWith(ids: string[]): Portfolio {
  return {
    version: 2,
    categories: createDefaultCategories().filter((c) => ids.includes(c.id)),
    history: [],
  }
}

const idsOf = (p: Portfolio) => p.categories.map((c) => c.id)
const writeStored = (raw: unknown) => void mem.set(STORAGE_KEY, JSON.stringify(raw))
const readMarker = (): string[] => JSON.parse(mem.get(CATEGORY_INTRO_KEY) as string)

beforeEach(() => mem.clear())

/* ------------------------------------------------------------------ *
 * 回归：删除内置分类不能被升级逻辑复活
 * ------------------------------------------------------------------ */
describe('删除内置分类后不再被迁移逻辑复活', () => {
  it('删除「国债」→ 重新打开：不复活、不再提示', () => {
    loadPortfolio() // 首次使用：先建立「已提供」标记
    const withoutBond = CATEGORY_IDS.filter((id) => id !== 'cat_bond')
    expect(savePortfolio(portfolioWith(withoutBond))).toBeNull()

    const reloaded = loadPortfolio()
    expect(idsOf(reloaded.portfolio)).toEqual(withoutBond)
    expect(reloaded.addedCategories).toBeUndefined()
  })

  it('六个内置分类逐个删除都不会复活', () => {
    loadPortfolio()
    for (const target of CATEGORY_IDS) {
      const kept = CATEGORY_IDS.filter((id) => id !== target)
      savePortfolio(portfolioWith(kept))
      const reloaded = loadPortfolio()
      expect(idsOf(reloaded.portfolio)).toEqual(kept)
      expect(reloaded.addedCategories).toBeUndefined()
    }
  })

  it('首次使用就删掉分类，重开同样不会复活', () => {
    // 不先 load：模拟用户装好应用后直接删分类
    savePortfolio(portfolioWith(CATEGORY_IDS.filter((id) => id !== 'cat_bond')))
    loadPortfolio() // 第一次打开：标记在本轮建立，且不能把删除的分类补回来
    const second = loadPortfolio()
    expect(idsOf(second.portfolio)).not.toContain('cat_bond')
    expect(second.addedCategories).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 已验收的升级迁移语义必须保持不变
 * ------------------------------------------------------------------ */
describe('内置分类升级迁移语义保持不变', () => {
  it('老数据缺「国债」：仍然补上并提示一次', () => {
    writeStored(portfolioWith(CATEGORY_IDS.filter((id) => id !== 'cat_bond')))
    const first = loadPortfolio()
    expect(first.addedCategories).toEqual(['国债'])
    expect(idsOf(first.portfolio)).toEqual(CATEGORY_IDS)
  })

  it('补齐之后再打开：不再提示，顺序不变（幂等）', () => {
    writeStored(portfolioWith(CATEGORY_IDS.filter((id) => id !== 'cat_bond')))
    const first = loadPortfolio()
    savePortfolio(first.portfolio)

    const second = loadPortfolio()
    expect(second.addedCategories).toBeUndefined()
    expect(idsOf(second.portfolio)).toEqual(CATEGORY_IDS)
  })

  it('从未提供过的内置分类（未来新增）仍会被补上', () => {
    const withoutBond = createDefaultCategories().filter((c) => c.id !== 'cat_bond')
    // 标记里只有当时已存在的 5 个 id —— 等价于「国债是之后版本才加的」
    const alreadyIntroduced = new Set(withoutBond.map((c) => c.id))
    const { added, categories } = mergeDefaultCategories(withoutBond, alreadyIntroduced)
    expect(added).toEqual(['cat_bond'])
    expect(categories.map((c) => c.id)).toEqual(CATEGORY_IDS)
  })

  it('不传标记时保持旧语义：缺失即补（已有调用方不受影响）', () => {
    const withoutBond = createDefaultCategories().filter((c) => c.id !== 'cat_bond')
    expect(mergeDefaultCategories(withoutBond).added).toEqual(['cat_bond'])
  })
})

/* ------------------------------------------------------------------ *
 * 分类被全部删光是一个合法状态（UI 有空状态）
 * ------------------------------------------------------------------ */
describe('分类全部删光', () => {
  it('normalizePortfolio：显式空数组保持为空', () => {
    expect(normalizePortfolio({ categories: [] })?.categories).toEqual([])
  })

  it('normalizePortfolio：脏数据（有内容但无合法分类）仍回退默认分类', () => {
    expect(normalizePortfolio({ categories: [{ id: 1 }, null] })?.categories.map((c) => c.id)).toEqual(
      CATEGORY_IDS,
    )
  })

  it('删光后重新打开：保持为空，且不弹「已新增分类」', () => {
    loadPortfolio()
    savePortfolio({ version: 2, categories: [], history: [] })

    const reloaded = loadPortfolio()
    expect(reloaded.portfolio.categories).toEqual([])
    expect(reloaded.addedCategories).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 旧键迁移也要走同一套补齐逻辑
 * ------------------------------------------------------------------ */
describe('旧版本键迁移', () => {
  it('从 portfolio/v1 迁移时同样补齐内置分类并落标记', () => {
    mem.set(
      'asset-card-wallet/portfolio/v1',
      JSON.stringify(portfolioWith(CATEGORY_IDS.filter((id) => id !== 'cat_bond'))),
    )
    const first = loadPortfolio()
    expect(first.addedCategories).toEqual(['国债'])
    expect(readMarker()).toContain('cat_bond')

    // 迁移过来之后再删掉，重开不会复活
    savePortfolio({ ...first.portfolio, categories: first.portfolio.categories.filter((c) => c.id !== 'cat_bond') })
    expect(idsOf(loadPortfolio().portfolio)).not.toContain('cat_bond')
  })
})

/* ------------------------------------------------------------------ *
 * 标记本身的健壮性与命名空间红线
 * ------------------------------------------------------------------ */
describe('分类标记的健壮性', () => {
  it('标记损坏时退化为旧行为，不抛错', () => {
    mem.set(CATEGORY_INTRO_KEY, '{不是合法 JSON')
    writeStored(portfolioWith(CATEGORY_IDS.filter((id) => id !== 'cat_bond')))
    const r = loadPortfolio()
    expect(r.addedCategories).toEqual(['国债'])
    expect(readMarker()).toContain('cat_bond') // 顺带自愈
  })

  it('只写 1.0 自己的 asset-card-wallet/* 命名空间，不碰 wealthcard/*', () => {
    loadPortfolio()
    savePortfolio(portfolioWith(['cat_cash']))
    expect(mem.size).toBeGreaterThan(0)
    expect([...mem.keys()].every((k) => k.startsWith('asset-card-wallet/'))).toBe(true)
  })

  it('clearPortfolio 同时清掉主数据与分类标记', () => {
    loadPortfolio()
    savePortfolio(portfolioWith(['cat_cash']))
    expect(mem.has(CATEGORY_INTRO_KEY)).toBe(true)

    clearPortfolio()
    expect(mem.has(STORAGE_KEY)).toBe(false)
    expect(mem.has(CATEGORY_INTRO_KEY)).toBe(false)
  })
})


/* ------------------------------------------------------------------ *
 * 条目字段的持久化：normalizeItem 是「重建对象」，漏字段就会在刷新后丢失
 * ------------------------------------------------------------------ */
describe('条目字段在重新加载后必须保留', () => {
  it('A股/场内市场不会被丢成场外基金（market 白名单要含 ashare）', () => {
    const pf = portfolioWith(CATEGORY_IDS)
    const stock = pf.categories.find((c) => c.id === 'cat_stock')!
    stock.items.push({
      id: 's1',
      kind: 'fund',
      name: '沪深300ETF',
      code: '510300',
      market: 'ashare',
      shares: 100,
      costNav: 1,
    })
    writeStored(pf)
    const loaded = loadPortfolio().portfolio
    const item = loaded.categories.find((c) => c.id === 'cat_stock')!.items[0]
    expect(item.kind).toBe('fund')
    expect(item.kind === 'fund' ? item.market : undefined).toBe('ashare')
  })

  it('债券期限与旧的人工资产类型标记都保留', () => {
    const pf = portfolioWith(CATEGORY_IDS)
    pf.categories.find((c) => c.id === 'cat_bond')!.items.push({
      id: 'b1',
      kind: 'amount',
      name: '10年期国债',
      amount: 1000,
      bondTerm: 'long',
    })
    pf.categories.find((c) => c.id === 'cat_fund')!.items.push({
      id: 'f1',
      kind: 'fund',
      name: '某纯债基金',
      code: '000001',
      shares: 1,
      costNav: 1,
      assetClass: 'bond',
      bondTerm: 'mid',
    })
    writeStored(pf)
    const loaded = loadPortfolio().portfolio
    const b = loaded.categories.find((c) => c.id === 'cat_bond')!.items[0]
    const f = loaded.categories.find((c) => c.id === 'cat_fund')!.items[0]
    expect(b.bondTerm).toBe('long')
    expect(f.kind === 'fund' ? f.assetClass : undefined).toBe('bond')
    expect(f.bondTerm).toBe('mid')
  })
})
