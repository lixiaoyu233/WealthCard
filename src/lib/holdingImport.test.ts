import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { AssetItem, Portfolio } from '../types/asset'
import {
  HOLDING_IMPORT_PROMPT,
  appendHoldings,
  cleanNumber,
  findDuplicate,
  mergeHoldingsInto,
  markdownTableToLines,
  parseHoldingText,
} from './holdingImport'

describe('cleanNumber：AI 输出的各种数字写法', () => {
  it('千分位与货币符号', () => {
    expect(cleanNumber('1,234.56').value).toBe(1234.56)
    expect(cleanNumber('¥1,234.56').value).toBe(1234.56)
    expect(cleanNumber('$520').value).toBe(520)
    expect(cleanNumber('1.2345元').value).toBe(1.2345)
  })
  it('万 / 亿 会换算并留痕', () => {
    expect(cleanNumber('1.2万')).toMatchObject({ value: 12000 })
    expect(cleanNumber('1.2万').note).toContain('万')
    expect(cleanNumber('1亿').value).toBe(100000000)
  })
  it('「手」按 1 手 = 100 股换算并留痕（券商截图最常见，差 100 倍）', () => {
    expect(cleanNumber('3手')).toMatchObject({ value: 300 })
    expect(cleanNumber('3手').note).toContain('1 手 = 100 股')
  })
  it('不是数字就标 bad', () => {
    expect(cleanNumber('约一万').bad).toBe(true)
    expect(cleanNumber('').value).toBeUndefined()
  })
})

describe('主格式：一行一个标的', () => {
  it('基金：字段顺序随意、名称与备注保留', () => {
    const r = parseHoldingText('类型=基金 代码=161725 名称=招商中证白酒 份额=12000 成本单价=1.2345 备注=支付宝')
    expect(r.failed).toEqual([])
    expect(r.holdings).toHaveLength(1)
    expect(r.holdings[0]).toMatchObject({
      type: 'fund',
      market: 'cn',
      code: '161725',
      name: '招商中证白酒',
      shares: 12000,
      costNav: 1.2345,
      note: '支付宝',
    })
    expect(r.holdings[0].issues).toEqual([])
  })

  it('A股 + 港股 + 美股 三行一起解析', () => {
    const r = parseHoldingText(
      [
        '类型=股票 市场=A股 代码=600519 名称=贵州茅台 份额=100 成本单价=1500',
        '类型=股票 市场=港股 代码=00700 名称=腾讯控股 份额=200 成本单价=380 币种=HKD',
        '类型=股票 市场=美股 代码=SPY 名称=标普500ETF 份额=10 成本单价=520 币种=USD',
      ].join('\n'),
    )
    expect(r.holdings.map((h) => [h.market, h.code])).toEqual([
      ['ashare', '600519'],
      ['hk', '00700'],
      ['us', 'SPY'],
    ])
    expect(r.summary).toMatchObject({ total: 3, ok: 3, failed: 0 })
  })

  it('成本总额按份额换算成单价，并给出提示', () => {
    const r = parseHoldingText('类型=股票 市场=A股 代码=600519 份额=100 成本总额=150000')
    expect(r.holdings[0].costNav).toBe(1500)
    expect(r.holdings[0].issues[0].message).toContain('成本总额 ÷ 份额')
    expect(r.summary).toMatchObject({ ok: 0, warned: 1 })
  })

  it('全角符号、中文别名键、分号分隔都能认', () => {
    const r = parseHoldingText('市场＝沪；股票代码＝600519；股数＝100；持仓成本价＝1500')
    expect(r.failed).toEqual([])
    expect(r.holdings[0]).toMatchObject({ market: 'ashare', code: '600519', shares: 100, costNav: 1500 })
  })

  it('「手」会换算成股并提示', () => {
    const r = parseHoldingText('类型=股票 市场=港股 代码=00700 份额=3手 成本单价=380')
    expect(r.holdings[0].shares).toBe(300)
    expect(r.holdings[0].issues.some((i) => i.message.includes('1 手 = 100 股'))).toBe(true)
  })

  it('没写市场时按代码推断，并提示推断了', () => {
    const r = parseHoldingText(
      ['类型=股票 代码=SPY 份额=10 成本单价=520', '类型=股票 代码=00700 份额=100 成本单价=380', '类型=股票 代码=600519 份额=100 成本单价=1500'].join('\n'),
    )
    expect(r.holdings.map((h) => h.market)).toEqual(['us', 'hk', 'ashare'])
    expect(r.holdings.every((h) => h.issues.some((i) => i.message.includes('没写市场')))).toBe(true)
  })

  it('没写成本：允许导入但警告（浮盈会失真）', () => {
    const r = parseHoldingText('类型=基金 代码=161725 份额=12000')
    expect(r.holdings).toHaveLength(1)
    expect(r.holdings[0].costNav).toBeUndefined()
    expect(r.holdings[0].issues[0].message).toContain('没给成本')
  })

  it('单价与总额对不上时按单价处理并警告', () => {
    const r = parseHoldingText('类型=股票 市场=A股 代码=600519 份额=100 成本单价=1500 成本总额=1')
    expect(r.holdings[0].costNav).toBe(1500)
    expect(r.holdings[0].issues.some((i) => i.message.includes('对不上'))).toBe(true)
  })

  it('币种与市场冲突时警告', () => {
    const r = parseHoldingText('类型=股票 市场=美股 代码=SPY 份额=10 成本单价=520 币种=CNY')
    expect(r.holdings[0].issues.some((i) => i.message.includes('与市场不一致'))).toBe(true)
  })
})

describe('容错与错误分级', () => {
  const expectFailed = (text: string, keyword: string) => {
    const r = parseHoldingText(text)
    expect(r.holdings).toEqual([])
    expect(r.failed[0].message).toContain(keyword)
  }

  it('错误：缺代码 / 缺份额 / 份额为 0 / 份额不是数字', () => {
    expectFailed('类型=基金 份额=100 成本单价=1', '缺少代码')
    expectFailed('类型=基金 代码=161725 成本单价=1', '缺少份额')
    expectFailed('类型=基金 代码=161725 份额=0 成本单价=1', '份额必须大于 0')
    expectFailed('类型=基金 代码=161725 份额=很多 成本单价=1', '不是有效数字')
  })

  it('错误：代码与市场不匹配（A股 6 位 / 港股 1~5 位 / 美股字母）', () => {
    expectFailed('类型=股票 市场=A股 代码=00700 份额=100 成本单价=1', '不符合 A股')
    expectFailed('类型=股票 市场=港股 代码=600519 份额=100 成本单价=1', '不符合 港股')
    expectFailed('类型=股票 市场=美股 代码=600519 份额=100 成本单价=1', '不符合 美股')
    expectFailed('类型=基金 代码=SPY 份额=100 成本单价=1', '不符合 场外基金')
  })

  it('错误：市场写成无法识别的词', () => {
    expectFailed('类型=股票 市场=纳斯达克xx 代码=SPY 份额=1 成本单价=1', '无法识别')
  })

  it('错误：整行没有键=值', () => {
    const r = parseHoldingText('贵州茅台 100 股 成本 1500')
    expect(r.failed[0].message).toContain('没有识别到')
  })

  it('错误行不影响其它行（好行照常导入）', () => {
    const r = parseHoldingText(
      ['类型=基金 代码=161725 份额=12000 成本单价=1.2', '这是一句废话', '类型=基金 代码=000001 份额=100 成本单价=1'].join('\n'),
    )
    expect(r.holdings).toHaveLength(2)
    expect(r.failed).toHaveLength(1)
    expect(r.summary).toMatchObject({ total: 3, ok: 2, failed: 1 })
  })
})

describe('注释行（给人看的、AI 自检用）', () => {
  it('# 开头被忽略并保留成 notes', () => {
    const r = parseHoldingText(
      [
        '# 校验：共 1 条，字段完整 1 条',
        '类型=基金 代码=161725 份额=12000 成本单价=1.2345',
        '# 缺少：腾讯控股 的成本（截图只显示了市值与盈亏）',
        '# 存疑：600519 的成本可能是总成本',
      ].join('\n'),
    )
    expect(r.holdings).toHaveLength(1)
    expect(r.failed).toEqual([])
    expect(r.notes).toEqual([
      '校验：共 1 条，字段完整 1 条',
      '缺少：腾讯控股 的成本（截图只显示了市值与盈亏）',
      '存疑：600519 的成本可能是总成本',
    ])
    expect(r.summary.total).toBe(1)
  })
})

describe('Markdown 表格（AI 很爱输出表格）', () => {
  const table = [
    '| 类型 | 市场 | 代码 | 名称 | 份额 | 成本单价 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| 基金 |  | 161725 | 招商中证白酒 | 12,000 | 1.2345 |',
    '| 股票 | A股 | 600519 | 贵州茅台 | 100 | 1,500 |',
  ].join('\n')

  it('表头当键，逐行解析', () => {
    const r = parseHoldingText(table)
    expect(r.failed).toEqual([])
    expect(r.holdings).toHaveLength(2)
    expect(r.holdings[0]).toMatchObject({ type: 'fund', code: '161725', shares: 12000, costNav: 1.2345 })
    expect(r.holdings[1]).toMatchObject({ type: 'stock', market: 'ashare', shares: 100, costNav: 1500 })
  })

  it('markdownTableToLines：没有代码列就不当表格处理', () => {
    expect(markdownTableToLines(['| a | b |', '| --- | --- |', '| 1 | 2 |'])).toBeNull()
    expect(markdownTableToLines(['类型=基金 代码=161725 份额=1'])).toBeNull()
  })
})

describe('重复检测', () => {
  it('同市场同代码算重复（忽略大小写）', () => {
    const [holding] = parseHoldingText('类型=股票 市场=美股 代码=spy 份额=10 成本单价=520').holdings
    expect(findDuplicate(holding, [{ id: 'a', code: 'SPY', market: 'us' }])).toBe(true)
    expect(findDuplicate(holding, [{ id: 'b', code: 'SPY', market: 'hk' }])).toBe(false)
    expect(findDuplicate(holding, [{ id: 'c', code: 'QQQ', market: 'us' }])).toBe(false)
  })
})

describe('提示词与文档同步', () => {
  it('docs/持仓导入提示词.md 里的提示词和代码里的一致（改一处要跑 node scripts/gen-import-prompt.mjs）', () => {
    const doc = readFileSync(new URL('../../docs/持仓导入提示词.md', import.meta.url), 'utf8')
    expect(doc).toContain(HOLDING_IMPORT_PROMPT.trim())
  })

  it('提示词覆盖了三个关键要求：缺什么要说、手换股、自检', () => {
    expect(HOLDING_IMPORT_PROMPT).toContain('# 缺少：')
    expect(HOLDING_IMPORT_PROMPT).toContain('1 手 = 100 股')
    expect(HOLDING_IMPORT_PROMPT).toContain('# 校验：共 N 条')
  })
})

describe('appendHoldings：一次性追加到组合', () => {
  const item = (id: string): AssetItem => ({ id, kind: 'amount', name: id, amount: 1 })
  const portfolio: Portfolio = {
    version: 2,
    history: [],
    categories: [
      { id: 'cat_fund', name: '基金', subtitle: '', icon: 'x', color: 'x', items: [] },
      { id: 'cat_stock', name: '股票', subtitle: '', icon: 'x', color: 'x', items: [] },
    ],
  }

  it('按分类追加，返回新增数量', () => {
    const res = appendHoldings(portfolio, [
      { categoryId: 'cat_fund', item: item('a') },
      { categoryId: 'cat_fund', item: item('b') },
      { categoryId: 'cat_stock', item: item('c') },
    ])
    expect(res.added).toBe(3)
    expect(res.portfolio.categories[0].items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(res.portfolio.categories[1].items.map((i) => i.id)).toEqual(['c'])
  })

  it('目标分类不存在时跳过并计数', () => {
    const res = appendHoldings(portfolio, [
      { categoryId: 'cat_none', item: item('x') },
      { categoryId: 'cat_fund', item: item('y') },
    ])
    expect(res).toMatchObject({ added: 1, skipped: 1 })
  })

  it('一条都没加进去时返回原对象（不触发无意义写盘）', () => {
    const res = appendHoldings(portfolio, [{ categoryId: 'cat_none', item: item('x') }])
    expect(res.portfolio).toBe(portfolio)
    expect(res.added).toBe(0)
  })
})

describe('默认类型（按打开的面板）', () => {
  it('基金面板里粘了一行没写类型的 6 位代码 → 当基金', () => {
    const r = parseHoldingText('代码=161725 份额=12000 成本单价=1.2345', { defaultType: 'fund' })
    expect(r.holdings[0]).toMatchObject({ type: 'fund', market: 'cn' })
  })

  it('股票面板里同样是 6 位代码 → 当 A股', () => {
    const r = parseHoldingText('代码=600519 份额=100 成本单价=1500', { defaultType: 'stock' })
    expect(r.holdings[0]).toMatchObject({ type: 'stock', market: 'ashare' })
  })
})


describe('金额模式：只有名称 + 金额的截图（很多平台总览页）', () => {
  it('没代码、没份额，只有名称和金额 → 按市值记账，不算错误', () => {
    const r = parseHoldingText('类型=基金 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27')
    expect(r.failed).toEqual([])
    expect(r.holdings[0]).toMatchObject({ mode: 'amount', amount: 10.27, shares: 0, code: '' })
    expect(r.holdings[0].issues[0].message).toContain('按市值记账')
  })

  it('有代码 + 金额 + 持仓收益（截图里就有这一列）', () => {
    const r = parseHoldingText('类型=基金 代码=016452 名称=南方纳斯达克100指数发起(QDII)A 金额=10.27 持仓收益=0.27')
    expect(r.failed).toEqual([])
    expect(r.holdings[0]).toMatchObject({ mode: 'amount', code: '016452', amount: 10.27, profit: 0.27 })
  })

  it('份额 + 金额 + 持仓收益 → 按「金额 − 收益」反推成本单价，并标来源', () => {
    const r = parseHoldingText('类型=基金 代码=016452 名称=x 份额=8 金额=10.27 持仓收益=0.27')
    const h = r.holdings[0]
    expect(h.mode).toBe('holding')
    expect(h.shares).toBe(8)
    expect(h.costNav).toBeCloseTo(1.25, 6) // (10.27 − 0.27) / 8
    expect(h.sources?.cost).toBe('derived-profit')
    expect(h.issues.some((i) => i.message.includes('反推成本单价'))).toBe(true)
  })

  it('份额×净值 与金额差太多 → 警告（净值日期不同或份额抄错）', () => {
    const r = parseHoldingText('类型=基金 代码=161725 份额=100 净值=2 金额=150 成本单价=1')
    expect(r.holdings[0].issues.some((i) => i.message.includes('请核对'))).toBe(true)
  })

  it('有份额没成本但给了净值 → 用净值当成本，盈亏按 0（不瞎猜）', () => {
    const r = parseHoldingText('类型=基金 代码=161725 份额=100 净值=1.2345')
    expect(r.holdings[0].costNav).toBeCloseTo(1.2345, 6)
    expect(r.holdings[0].sources?.cost).toBe('fallback-nav')
  })

  it('什么都没有（只有名称）→ 明确报错，提示可以给金额', () => {
    const r = parseHoldingText('类型=基金 名称=某某基金')
    expect(r.holdings).toEqual([])
    expect(r.failed[0].message).toContain('金额')
  })

  it('Markdown 表格里的「持仓金额」列也能识别成金额模式', () => {
    const table = ['| 名称 | 持仓金额 | 持仓收益 |', '| --- | --- | --- |', '| 中欧国证自由现金流指数A | 9.85 | -0.11 |'].join('\n')
    const r = parseHoldingText(table)
    expect(r.failed).toEqual([])
    expect(r.holdings[0]).toMatchObject({ mode: 'amount', amount: 9.85, profit: -0.11 })
  })
})


describe('AI 的说明行（没有 # 前缀）', () => {
  it('「校验：…」「存疑：…」当注释收起来，不报成错误行', () => {
    const r = parseHoldingText(
      [
        '类型=基金 名称=景顺长城沪港深红利成长低波指数A 金额=10.28 持仓收益=0.28',
        '',
        '校验：共 8 条，字段完整 8 条',
        '存疑：全部标的的代码、份额、成本单价截图内未展示',
      ].join('\n'),
    )
    expect(r.failed).toEqual([])
    expect(r.holdings).toHaveLength(1)
    expect(r.notes).toEqual([
      '校验：共 8 条，字段完整 8 条',
      '存疑：全部标的的代码、份额、成本单价截图内未展示',
    ])
  })

  it('其他说明词也认（缺少 / 换算 / 说明 / 合计）', () => {
    const r = parseHoldingText(
      ['类型=基金 名称=x 金额=1', '缺少：腾讯控股的成本', '换算：3 手 → 300 股', '说明：截图只有总览', '合计：8 条'].join(
        '\n',
      ),
    )
    expect(r.failed).toEqual([])
    expect(r.notes).toHaveLength(4)
  })

  it('既没说明词又没键=值的行，仍然报错（真的是脏数据）', () => {
    const r = parseHoldingText('类型=基金 名称=x 金额=1\n随便写点什么')
    expect(r.failed).toHaveLength(1)
    expect(r.notes).toEqual([])
  })
})


describe('合并到已有条目：份额相加 + 成本加权平均', () => {
  it('两条并成一条', () => {
    const portfolio = {
      version: 2,
      history: [],
      categories: [
        {
          id: 'cat_fund',
          name: '基金',
          subtitle: '',
          icon: 'x',
          color: '#888',
          items: [{ id: 'f1', kind: 'fund' as const, name: '南方纳斯达克100', code: '016452', market: 'cn' as const, shares: 10, costNav: 2 }],
        },
      ],
    } as unknown as Portfolio
    const res = mergeHoldingsInto(portfolio, [{ itemId: 'f1', shares: 4.39, costNav: 2.2778, note: '支付宝' }])
    expect(res.merged).toBe(1)
    const item = res.portfolio.categories[0].items[0] as unknown as { shares: number; costNav: number; note?: string }
    expect(item.shares).toBeCloseTo(14.39, 6)
    expect(item.costNav).toBeCloseTo((10 * 2 + 4.39 * 2.2778) / 14.39, 6)
    expect(item.note).toBe('支付宝')
  })

  it('份额为 0 的合并请求被跳过（不会把条目改坏）', () => {
    const portfolio = {
      version: 2,
      history: [],
      categories: [{ id: 'c', name: 'c', subtitle: '', icon: 'x', color: '#888', items: [{ id: 'f1', kind: 'fund' as const, name: 'x', code: '1', shares: 10, costNav: 2 }] }],
    } as unknown as Portfolio
    const res = mergeHoldingsInto(portfolio, [{ itemId: 'f1', shares: 0, costNav: 1 }])
    expect(res.merged).toBe(0)
    expect(res.portfolio).toBe(portfolio)
  })
})
