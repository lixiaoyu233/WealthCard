/**
 * 持仓文本导入：把「别的 AI 识别截图后输出的文本」解析成持仓条目。
 *
 * 为什么不收 JSON：AI 输出 JSON 容易夹代码块、注释、字段自创；文本行格式对 AI 宽容、
 * 对人可读，还能用 # 写注释（导入时忽略）。写入权始终在用户手里（预览 + 勾选）。
 *
 * 规范（v1）见 docs/持仓导入提示词.md：
 *   类型=基金|股票 市场=A股|港股|美股 代码= 名称= 份额= 成本单价=/成本总额= 币种= 现价= 备注=
 *   一行一个标的；字段顺序随意；# 开头为注释；也兼容 Markdown 表格。
 */
import type { AssetItem, Portfolio } from '../types/asset'
import type { CurrencyCode } from './currency'
import type { HoldingMarket } from './usStock'

export const HOLDING_IMPORT_VERSION = 'v1'

export type ImportType = 'fund' | 'stock'
export type IssueLevel = 'error' | 'warning'

export interface ImportIssue {
  level: IssueLevel
  message: string
}

export interface ParsedHolding {
  /** 源文本行号（1 起） */
  line: number
  type: ImportType
  market: HoldingMarket
  code: string
  name?: string
  shares: number
  /** 每份/每股成本（由成本总额换算或直接给出） */
  costNav?: number
  /** 当前价（可选，行情拉不到时的兜底） */
  price?: number
  currency?: CurrencyCode
  note?: string
  issues: ImportIssue[]
}

export interface FailedLine {
  line: number
  text: string
  message: string
}

export interface ImportParseResult {
  holdings: ParsedHolding[]
  failed: FailedLine[]
  /** # 注释行（含 AI 的「# 缺少：…」「# 存疑：…」） */
  notes: string[]
  summary: { total: number; ok: number; warned: number; failed: number }
}

export interface ParseOptions {
  /** 从哪个面板打开：决定没写「类型」时的默认归属 */
  defaultType?: ImportType
}

/* ------------------------------------------------------------------ *
 * 字段名归一
 * ------------------------------------------------------------------ */

const FIELD_ALIASES: Record<string, string> = {
  类型: 'type', type: 'type', 类别: 'type',
  市场: 'market', market: 'market', 交易所: 'market',
  代码: 'code', code: 'code', 基金代码: 'code', 股票代码: 'code', 证券代码: 'code',
  名称: 'name', name: 'name', 基金名称: 'name', 股票名称: 'name', 证券名称: 'name',
  份额: 'shares', shares: 'shares', 持有份额: 'shares', 股数: 'shares', 持仓份额: 'shares',
  持股数: 'shares', quantity: 'shares', qty: 'shares',
  成本单价: 'costNav', 单价: 'costNav', 成本价: 'costNav', costnav: 'costNav',
  cost: 'costNav', price: 'costNav', 买入单价: 'costNav', 持仓成本价: 'costNav',
  成本总额: 'costTotal', 总成本: 'costTotal', 成本金额: 'costTotal', total: 'costTotal',
  costtotal: 'costTotal', 买入金额: 'costTotal', 持仓成本: 'costTotal',
  币种: 'currency', currency: 'currency', 货币: 'currency',
  现价: 'price', 最新价: 'price', 净值: 'price', 当前价: 'price', nav: 'price', 单位净值: 'price',
  备注: 'note', note: 'note', 账户: 'note', 说明: 'note', remark: 'note',
}

const canonicalKey = (raw: string): string | undefined => {
  const key = raw.trim().toLowerCase().replace(/[\s_*]/g, '')
  return FIELD_ALIASES[key] ?? FIELD_ALIASES[raw.trim()]
}

/* ------------------------------------------------------------------ *
 * 数值清洗：千分位、货币符号、单位、万/亿、手→股
 * ------------------------------------------------------------------ */

export interface CleanNumber {
  value?: number
  /** 换算说明（例如「3 手 → 300 股」） */
  note?: string
  /** 遇到无法识别的内容 */
  bad?: boolean
}

export function cleanNumber(raw: string): CleanNumber {
  let s = raw.trim().replace(/["'（）()\s]/g, '')
  if (!s) return {}
  const notes: string[] = []

  // 手 → 股（券商截图常见；按 1 手 = 100 股换算并留痕）
  const lot = /手$/.test(s)
  if (lot) {
    s = s.replace(/手$/, '')
    notes.push('按 1 手 = 100 股 换算')
  }

  // 万 / 亿
  let scale = 1
  if (/万$/.test(s)) {
    scale = 10_000
    s = s.replace(/万$/, '')
    notes.push('按「万」换算')
  } else if (/亿$/.test(s)) {
    scale = 100_000_000
    s = s.replace(/亿$/, '')
    notes.push('按「亿」换算')
  }

  // 千分位与货币/单位符号
  s = s.replace(/[,，]/g, '').replace(/[¥$￥€£]/g, '').replace(/港元|港币|美元|人民币|元|份|股/g, '')
  s = s.replace(/[+＋]/g, '')
  if (!/^-?\d*\.?\d+$/.test(s)) return { bad: true }
  const n = Number(s)
  if (!Number.isFinite(n)) return { bad: true }
  const value = lot ? n * 100 * scale : n * scale
  return { value, note: notes.length ? notes.join('；') : undefined }
}

/* ------------------------------------------------------------------ *
 * 市场 / 类型 / 币种
 * ------------------------------------------------------------------ */

const MARKET_ALIASES: Array<[RegExp, HoldingMarket]> = [
  [/^(a股|a|沪深|沪|深|境内|上海|深圳|sh|sz)$/i, 'ashare'],
  [/^(港股|hk|香港|h)$/i, 'hk'],
  [/^(美股|us|美国|纳斯达克|纽交所|nasdaq|nyse)$/i, 'us'],
  [/^(基金|场外|场外基金|otc|cn)$/i, 'cn'],
]

export function normalizeMarket(raw: string): HoldingMarket | undefined {
  const s = raw.trim()
  for (const [re, market] of MARKET_ALIASES) if (re.test(s)) return market
  return undefined
}

export function normalizeType(raw: string): ImportType | undefined {
  const s = raw.trim()
  if (/^(基金|场外|场外基金|fund|otc)$/i.test(s)) return 'fund'
  if (/^(股票|个股|stock|equity|a股|港股|美股)$/i.test(s)) return 'stock'
  return undefined
}

const CURRENCIES: CurrencyCode[] = ['CNY', 'USD', 'HKD']
export const currencyForMarket = (market: HoldingMarket): CurrencyCode =>
  market === 'us' ? 'USD' : market === 'hk' ? 'HKD' : 'CNY'

/** 只按代码外形推断市场（A股与场外基金同形，必须由「类型」区分） */
export function inferMarket(code: string, type: ImportType): HoldingMarket {
  const c = code.trim()
  if (type === 'fund') return 'cn'
  if (/^[A-Za-z][A-Za-z.\-]*$/.test(c)) return 'us'
  if (/^\d{1,5}$/.test(c)) return 'hk'
  return 'ashare'
}

const codeValid = (code: string, market: HoldingMarket): boolean => {
  const c = code.trim()
  if (market === 'cn' || market === 'ashare') return /^\d{6}$/.test(c)
  if (market === 'hk') return /^\d{1,5}$/.test(c)
  return /^[A-Za-z][A-Za-z.\-]{0,9}$/.test(c)
}

/* ------------------------------------------------------------------ *
 * 行解析
 * ------------------------------------------------------------------ */

/** 把一行拆成 键=值；分隔符支持空格、英文/中文分号、竖线 */
function splitPairs(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const cleaned = line.replace(/[；;|]/g, ' ').replace(/[＝]/g, '=')
  const re = /([^=\s]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned))) {
    const key = m[1]
    const value = m[3] ?? m[4] ?? m[2]
    out.push([key, value])
  }
  return out
}

function parseRow(line: string, lineNo: number, options: ParseOptions): ParsedHolding | FailedLine {
  const pairs = splitPairs(line)
  const fields: Record<string, string> = {}
  for (const [key, value] of pairs) {
    const canon = canonicalKey(key)
    if (canon && !(canon in fields)) fields[canon] = value
  }
  if (Object.keys(fields).length === 0) {
    return { line: lineNo, text: line, message: '这一行没有识别到「键=值」字段' }
  }

  const issues: ImportIssue[] = []
  const marketHint = fields.market ? normalizeMarket(fields.market) : undefined
  const rawType = fields.type ? normalizeType(fields.type) : undefined
  if (fields.type && !rawType) issues.push({ level: 'warning', message: `类型「${fields.type}」不认识，按默认处理` })
  // 没写类型时：写了股票市场（A股/港股/美股）就按股票算，否则用面板默认
  const type: ImportType =
    rawType ?? (marketHint && marketHint !== 'cn' ? 'stock' : (options.defaultType ?? 'fund'))

  const code = (fields.code ?? '').trim()
  if (!code) return { line: lineNo, text: line, message: '缺少代码' }

  let market: HoldingMarket
  if (type === 'fund') {
    market = 'cn'
    if (fields.market && normalizeMarket(fields.market) && normalizeMarket(fields.market) !== 'cn') {
      issues.push({ level: 'warning', message: `类型是基金，市场写成「${fields.market}」已按场外基金处理` })
    }
  } else if (fields.market) {
    const parsed = normalizeMarket(fields.market)
    if (!parsed || parsed === 'cn') {
      return { line: lineNo, text: line, message: `市场「${fields.market}」无法识别（应为 A股 / 港股 / 美股）` }
    }
    market = parsed
  } else {
    market = inferMarket(code, type)
    issues.push({ level: 'warning', message: `没写市场，按代码推断为 ${market === 'ashare' ? 'A股' : market === 'hk' ? '港股' : '美股'}` })
  }

  if (!codeValid(code, market)) {
    return {
      line: lineNo,
      text: line,
      message: `代码「${code}」不符合 ${market === 'cn' ? '场外基金（6 位数字）' : market === 'ashare' ? 'A股（6 位数字）' : market === 'hk' ? '港股（1~5 位数字）' : '美股（字母代码）'} 的格式`,
    }
  }

  const sharesRaw = fields.shares ? cleanNumber(fields.shares) : {}
  if (!fields.shares) return { line: lineNo, text: line, message: '缺少份额（份数/股数）' }
  if (sharesRaw.bad || sharesRaw.value === undefined) {
    return { line: lineNo, text: line, message: `份额「${fields.shares}」不是有效数字` }
  }
  const shares = sharesRaw.value
  if (!(shares > 0)) return { line: lineNo, text: line, message: '份额必须大于 0' }
  if (sharesRaw.note) issues.push({ level: 'warning', message: `份额 ${sharesRaw.note}` })

  // 成本：单价优先，其次总额 ÷ 份额；都没有则警告
  let costNav: number | undefined
  const unit = fields.costNav ? cleanNumber(fields.costNav) : {}
  const total = fields.costTotal ? cleanNumber(fields.costTotal) : {}
  if (unit.bad || total.bad) {
    return { line: lineNo, text: line, message: '成本不是有效数字' }
  }
  if (unit.value !== undefined) {
    costNav = unit.value
    if (costNav < 0) return { line: lineNo, text: line, message: '成本不能是负数' }
    if (total.value !== undefined && Math.abs(total.value / shares - costNav) > Math.max(0.01, costNav * 0.02)) {
      issues.push({ level: 'warning', message: '同时给了成本单价与成本总额，两者对不上，已按单价处理' })
    }
  } else if (total.value !== undefined) {
    costNav = total.value / shares
    issues.push({ level: 'warning', message: `按成本总额 ÷ 份额 换算成单价 ${costNav.toFixed(4)}` })
  } else {
    issues.push({ level: 'warning', message: '没给成本，导入后浮盈会失真，建议补上' })
  }

  const price = fields.price ? cleanNumber(fields.price) : {}
  if (price.bad) issues.push({ level: 'warning', message: `现价「${fields.price}」不是有效数字，已忽略` })

  let currency: CurrencyCode | undefined
  if (fields.currency) {
    const c = fields.currency.trim().toUpperCase()
    if (CURRENCIES.includes(c as CurrencyCode)) {
      currency = c as CurrencyCode
      const expect = currencyForMarket(market)
      if (currency !== expect) issues.push({ level: 'warning', message: `币种 ${currency} 与市场不一致（通常应为 ${expect}）` })
    } else {
      issues.push({ level: 'warning', message: `币种「${fields.currency}」不认识，已按市场推断` })
    }
  }

  return {
    line: lineNo,
    type,
    market,
    code,
    name: fields.name?.trim() || undefined,
    shares,
    costNav,
    price: price.value !== undefined && !price.bad ? price.value : undefined,
    currency,
    note: fields.note?.trim() || undefined,
    issues,
  }
}

/* ------------------------------------------------------------------ *
 * Markdown 表格 → 行文本
 * ------------------------------------------------------------------ */

/** 把 Markdown 表格转换成「键=值」行（表头作为键） */
export function markdownTableToLines(lines: string[]): { lines: string[]; used: number } | null {
  const rows = lines.map((l) => l.trim()).filter((l) => l.startsWith('|'))
  if (rows.length < 2) return null
  const cells = (l: string) =>
    l
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const header = cells(rows[0])
  if (!header.some((h) => canonicalKey(h) === 'code')) return null
  const out: string[] = []
  for (const row of rows.slice(1)) {
    if (/^[\s|:-]+$/.test(row)) continue // |---|---|
    const values = cells(row)
    const parts: string[] = []
    header.forEach((h, i) => {
      const v = values[i] ?? ''
      if (v) parts.push(`${h}=${v}`)
    })
    if (parts.length) out.push(parts.join(' '))
  }
  return { lines: out, used: out.length }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function parseHoldingText(text: string, options: ParseOptions = {}): ImportParseResult {
  const rawLines = text.split(/\r?\n/)
  const notes: string[] = []
  const body: Array<{ line: number; text: string }> = []

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim()
    if (!line) continue
    if (/^#/.test(line) || /^\/\//.test(line)) {
      notes.push(line.replace(/^(#|\/\/)\s*/, ''))
      continue
    }
    body.push({ line: i + 1, text: line })
  }

  // 整段是 Markdown 表格时整体转换
  const table = markdownTableToLines(body.map((b) => b.text))
  const work: Array<{ line: number; text: string }> = table
    ? table.lines.map((t, i) => ({ line: i + 1, text: t }))
    : body

  const holdings: ParsedHolding[] = []
  const failed: FailedLine[] = []
  for (const item of work) {
    const parsed = parseRow(item.text, item.line, options)
    if ('message' in parsed) failed.push(parsed)
    else holdings.push(parsed)
  }

  const warned = holdings.filter((h) => h.issues.length > 0).length
  return {
    holdings,
    failed,
    notes,
    summary: { total: holdings.length + failed.length, ok: holdings.length - warned, warned, failed: failed.length },
  }
}

/** 一键复制给别的 AI 的提示词（与 docs/持仓导入提示词.md 同源） */
export const HOLDING_IMPORT_PROMPT = `你是持仓截图识别助手。请把截图里的基金/股票持仓，按下面格式输出成一段纯文本，不要输出 JSON、不要输出表格。

【必需信息】每个标的都要能看到：名称或代码、持有份额、成本（成本单价或成本总额）。
如果截图里缺哪一项，就在末尾用一行「# 缺少：<标的> 的 <字段>（截图中看不到 <原因>）」说明，不要猜测、不要编造数字。

【单位】如果截图按「手」显示，请先换算成股（1 手 = 100 股），并在末尾写一行「# 换算：<标的> X 手 → Y 股」。
份额要填份数/股数，不要填金额。

【格式】一行一个标的，字段写成 键=值，用空格隔开：
类型=基金|股票 市场=A股|港股|美股 代码= 名称= 份额= 成本单价= 成本总额= 币种= 现价= 备注=

- 类型=基金：场外基金，6 位数字代码，市场可省略；类型=股票：必须写市场
- 成本单价 与 成本总额 只写你更确定的那个，不要把一个数字同时写成两个
- 币种：港股 HKD、美股 USD、A股与基金 CNY；不确定可省略
- 金额可带千分位与货币符号（1,234.56 / ¥1234.56 / $520）
- 同一标的出现在多行（不同账户）请分别输出，并在 备注 里写账户
- # 开头的行是注释，导入时会被忽略

【最后请自检】在末尾补两行（没有就写「无」）：
# 校验：共 N 条，字段完整 M 条
# 存疑：<哪一条的哪个字段看不清或可能看错>

【示例】
类型=基金 代码=161725 名称=招商中证白酒 份额=12000 成本单价=1.2345 备注=支付宝
类型=股票 市场=A股 代码=600519 名称=贵州茅台 份额=100 成本总额=150000
类型=股票 市场=美股 代码=SPY 名称=标普500ETF 份额=10 成本单价=520 币种=USD
# 校验：共 3 条，字段完整 3 条
# 存疑：无`

/**
 * 把导入的条目追加到组合里（一次性写回，避免逐条写 N 次）。
 * 目标分类不存在时该行被跳过，由调用方提示。
 */
export function appendHoldings(
  portfolio: Portfolio,
  entries: Array<{ categoryId: string; item: AssetItem }>,
): { portfolio: Portfolio; added: number; skipped: number } {
  let added = 0
  let skipped = 0
  const byCategory = new Map<string, AssetItem[]>()
  for (const entry of entries) {
    if (!portfolio.categories.some((c) => c.id === entry.categoryId)) {
      skipped += 1
      continue
    }
    const list = byCategory.get(entry.categoryId) ?? []
    list.push(entry.item)
    byCategory.set(entry.categoryId, list)
    added += 1
  }
  if (added === 0) return { portfolio, added: 0, skipped }
  return {
    portfolio: {
      ...portfolio,
      categories: portfolio.categories.map((c) =>
        byCategory.has(c.id) ? { ...c, items: [...c.items, ...(byCategory.get(c.id) ?? [])] } : c,
      ),
    },
    added,
    skipped,
  }
}

/** 同代码（同市场）在已有持仓里的重复项 */
export function findDuplicate(
  holding: ParsedHolding,
  existing: Array<{ code: string; market?: HoldingMarket }>,
): boolean {
  return existing.some(
    (e) => e.code.trim().toUpperCase() === holding.code.toUpperCase() && (e.market ?? 'cn') === holding.market,
  )
}
