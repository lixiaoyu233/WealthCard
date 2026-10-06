import { describe, expect, it } from 'vitest'
import { parseHoldingText } from './holdingImport'
import {
  enrichHolding,
  nameSimilar,
  normalizeFundName,
  parseFundSearch,
  pickFundCandidate,
  searchFund,
  searchKeyOf,
} from './fundSearch'

const skipApi = process.env.ACW_SKIP_API === '1'

/** 真实响应的裁剪版（2026-10 实测：一次返回 A/C/I 三类份额） */
const SEARCH_FIXTURE = {
  Datas: [
    { CODE: '016452', NAME: '南方纳斯达克100指数发起(QDII)A', CATEGORYDESC: '基金' },
    { CODE: '016453', NAME: '南方纳斯达克100指数发起(QDII)C', CATEGORYDESC: '基金' },
    { CODE: '021000', NAME: '南方纳斯达克100指数发起(QDII)I', CATEGORYDESC: '基金' },
    { CODE: 'BAD', NAME: '脏数据' },
  ],
}

describe('名称规范化与搜索关键字', () => {
  it('全角括号、空白、间隔号统一', () => {
    expect(normalizeFundName('南方纳斯达克100指数发起（QDII）A')).toBe('南方纳斯达克100指数发起(QDII)A')
    expect(normalizeFundName('摩根标普 500 指数')).toBe('摩根标普500指数')
  })

  it('搜索关键字去掉结尾的 (QDII) 与份额字母，免得只搜到某一类', () => {
    expect(searchKeyOf('南方纳斯达克100指数发起（QDII）A')).toBe('南方纳斯达克100指数发起')
    expect(searchKeyOf('中欧国证自由现金流指数A')).toBe('中欧国证自由现金流指数')
    expect(searchKeyOf('招商中证白酒指数(LOF)A')).toBe('招商中证白酒指数')
  })
})

describe('候选挑选', () => {
  const candidates = parseFundSearch(SEARCH_FIXTURE)

  it('脏数据被过滤', () => {
    expect(candidates).toHaveLength(3)
    expect(candidates.map((c) => c.code)).toEqual(['016452', '016453', '021000'])
  })

  it('恰好同名 → 直接用', () => {
    expect(pickFundCandidate('南方纳斯达克100指数发起(QDII)C', candidates).best?.code).toBe('016453')
  })

  it('A/C/I 都命中时默认选 A 类，并标记 ambiguous', () => {
    const picked = pickFundCandidate('南方纳斯达克100指数发起', candidates)
    expect(picked.best?.code).toBe('016452')
    expect(picked.ambiguous).toBe(true)
  })

  it('没有候选 → 没有 best', () => {
    expect(pickFundCandidate('不存在', []).best).toBeUndefined()
  })

  it('名称相似度：同一只基金的不同份额算相似，不同基金不算', () => {
    expect(nameSimilar('南方纳斯达克100指数发起(QDII)A', '南方纳斯达克100指数发起(QDII)C')).toBe(true)
    expect(nameSimilar('招商中证白酒指数A', '易方达蓝筹精选混合')).toBe(false)
    expect(nameSimilar(undefined, '任意')).toBe(true)
  })
})

describe('enrichHolding：补代码 / 份额 / 成本（离线，用注入数据）', () => {
  const parseOne = (text: string) => parseHoldingText(text).holdings[0]

  it('只有名称 + 金额 + 持仓收益 → 搜到代码、按净值推份额、按收益反推成本', async () => {
    const h = parseOne('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27 持仓收益=0.27')
    const e = await enrichHolding(h, {
      online: false,
      candidatesOverride: parseFundSearch(SEARCH_FIXTURE),
      basicOverride: { name: '南方纳斯达克100指数发起(QDII)A', ftype: '指数型-海外股票', nav: 1.25, navDate: '2026-10-05' },
    })
    expect(e.code).toBe('016452')
    expect(e.sources.code).toBe('name-search')
    expect(e.nav).toBe(1.25)
    expect(e.navDate).toBe('2026-10-05')
    expect(e.shares).toBeCloseTo(10.27 / 1.25, 6)
    expect(e.sources.shares).toBe('derived-nav')
    // 成本 = (10.27 − 0.27) ÷ 份额 = 1.25 × (10/10.27)
    expect(e.costNav).toBeCloseTo((10.27 - 0.27) / (10.27 / 1.25), 6)
    expect(e.sources.cost).toBe('derived-profit')
    expect(e.notes.some((n) => n.includes('推算'))).toBe(true)
  })

  it('截图里本来就有份额与成本 → 一律标「来自截图」，不改数', async () => {
    const h = parseOne('类型=基金 代码=016452 名称=x 份额=100 成本单价=1.2 金额=125')
    const e = await enrichHolding(h, { online: false })
    expect(e.sources.code).toBe('screenshot')
    expect(e.shares).toBe(100)
    expect(e.sources.shares).toBe('screenshot')
    expect(e.costNav).toBe(1.2)
  })

  it('没有成本但有净值 → 用净值当成本（盈亏按 0），标 fallback-nav', async () => {
    const h = parseOne('类型=基金 名称=某某基金 金额=100 份额=80')
    const e = await enrichHolding(h, { online: false, basicOverride: { nav: 1.25, navDate: '2026-10-05' } })
    expect(e.costNav).toBe(1.25)
    expect(e.sources.cost).toBe('fallback-nav')
  })

  it('官方名称与截图名称差太多 → 给出核对提示', async () => {
    const h = parseOne('类型=基金 名称=某某白酒基金 金额=100')
    const e = await enrichHolding(h, {
      online: false,
      candidatesOverride: [{ code: '161725', name: '招商中证白酒指数(LOF)A' }],
      basicOverride: { name: '招商中证白酒指数(LOF)A', nav: 1.2 },
    })
    expect(e.notes.some((n) => n.includes('官方名称'))).toBe(true)
  })

  it('搜不到代码时也能导入（保持按金额记账），并给出提示', async () => {
    const h = parseOne('类型=基金 名称=某某查不到的基金 金额=100')
    const e = await enrichHolding(h, { online: false, candidatesOverride: [] })
    expect(e.code).toBeUndefined()
    expect(e.notes.some((n) => n.includes('没搜到'))).toBe(true)
  })
})

describe.skipIf(skipApi)('真实接口：名称 → 代码 → 净值 → 份额', () => {
  it('搜「南方纳斯达克100指数发起」能拿到 A/C/I 三类', async () => {
    const found = await searchFund('南方纳斯达克100指数发起')
    expect(found.length).toBeGreaterThan(0)
    expect(found.map((c) => c.code)).toContain('016452')
  }, 25_000)

  it('端到端：截图里那行「只有名称+金额+收益」能补成可算盈亏的持仓', async () => {
    const h = parseHoldingText(
      '类型=基金 名称=南方纳斯达克100指数发起（QDII）A 金额=10.27 持仓收益=0.27',
    ).holdings[0]
    const e = await enrichHolding(h)
    expect(e.code).toBe('016452')
    expect(e.nav).toBeGreaterThan(0)
    expect(e.shares).toBeGreaterThan(0)
    expect(e.costNav).toBeGreaterThan(0)
    console.log(
      `[补全] ${h.name} → ${e.code} 净值=${e.nav}(${e.navDate}) 份额≈${e.shares?.toFixed(2)} 成本≈${e.costNav?.toFixed(4)}`,
    )
  }, 30_000)
})
