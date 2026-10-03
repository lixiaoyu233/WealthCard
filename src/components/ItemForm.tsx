import { useEffect, useMemo, useRef, useState } from 'react'
import { Calculator, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { AssetItem, Category, FundQuote } from '../types/asset'
import { CURRENCIES, type CurrencyCode, type FxRates, isCurrencyCode, scaleHint, toCny } from '../lib/currency'
import { defaultItemKind, isFund, isGold, parseAmount } from '../lib/calc'
import { formatCNY, formatNav, formatRate, formatSigned } from '../lib/format'
import { makeAmountItem, makeFundItem, makeGoldItem } from '../hooks/usePortfolio'
import { fetchFundQuotes } from '../lib/fundService'
import NumberPad from './NumberPad'

interface ItemFormProps {
  category: Category
  /** 汇率：外币录入时实时预览折算金额 */
  rates?: FxRates | null
  /** 传入表示编辑，不传表示新增 */
  initial?: AssetItem
  onSubmit: (item: AssetItem) => void
  onDelete?: () => void
  onCancel: () => void
}

type PickerField = 'amount' | 'shares' | 'costNav' | 'grams' | 'pricePerGram' | null

interface FieldMeta {
  label: string
  unit?: string
  quick?: Array<{ label: string; value: string }>
}

/**
 * 分类定制提示词。
 * 按「分类 id 优先、其次分类名关键词」匹配，让提示更贴近真实场景：
 * 银行类给招商银行/支付宝，股票类给指数名，国债类给中美国债。
 */
const HINT_PRESETS: Array<{
  match: (categoryId: string, categoryName: string) => boolean
  name: string
  note: string
  currencyHint?: string
}> = [
  {
    match: (id, n) => id === 'cat_cash' || /现金|存款|银行|固定资产/.test(n),
    name: '招商银行 / 支付宝 / 微信零钱 / 自住房',
    note: '工资卡 / 余额宝 / 活期',
  },
  {
    match: (id, n) => id === 'cat_stock' || /股票|证券/.test(n),
    name: '中证A500 / 标普500 / 纳指100 / 贵州茅台',
    note: '场内ETF / 券商账户',
  },
  {
    match: (id, n) => id === 'cat_fund' || /基金/.test(n),
    name: '招商中证白酒 / 易方达蓝筹',
    note: '定投 / 场外',
  },
  {
    match: (id, n) => id === 'cat_gold' || /黄金|贵金属/.test(n),
    name: '工行积存金 / 支付宝黄金 / 周大福',
    note: '银行积存 / 实物金',
  },
  {
    match: (id, n) => id === 'cat_bond' || /国债|债券/.test(n),
    name: '中国10年期国债 / 美国10年期国债',
    note: '储蓄国债 / 记账式',
  },
  {
    match: (id, n) => id === 'cat_debt' || /负债|贷款|信用卡/.test(n),
    name: '招行房贷 / 信用卡账单 / 花呗',
    note: '等额本息 / 剩余本金',
  },
]

const FIELD_META: Record<Exclude<PickerField, null>, FieldMeta> = {
  amount: {
    label: '金额',
    unit: '元',
    quick: [
      { label: '1千', value: '1000' },
      { label: '1万', value: '10000' },
      { label: '5万', value: '50000' },
      { label: '10万', value: '100000' },
      { label: '50万', value: '500000' },
      { label: '100万', value: '1000000' },
    ],
  },
  shares: { label: '持有份额', unit: '份' },
  costNav: { label: '成本单价', unit: '元/份' },
  grams: {
    label: '持有克数',
    unit: '克',
    quick: [
      { label: '10克', value: '10' },
      { label: '20克', value: '20' },
      { label: '50克', value: '50' },
      { label: '100克', value: '100' },
    ],
  },
  pricePerGram: {
    label: '计价单价',
    unit: '元/克',
    quick: [
      { label: '550', value: '550' },
      { label: '600', value: '600' },
      { label: '650', value: '650' },
      { label: '700', value: '700' },
    ],
  },
}

export default function ItemForm({ category, rates, initial, onSubmit, onDelete, onCancel }: ItemFormProps) {
  const editing = Boolean(initial)
  // 编辑时沿用原形态；新增时按分类推断（空分类也能正确给出基金/黄金表单）
  const kind: AssetItem['kind'] = initial?.kind ?? defaultItemKind(category)

  const [name, setName] = useState(initial?.name ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const [amount, setAmount] = useState(initial && !isFund(initial) && !isGold(initial) ? String(initial.amount ?? '') : '')
  const [code, setCode] = useState(initial && isFund(initial) ? initial.code : '')
  const [shares, setShares] = useState(initial && isFund(initial) ? String(initial.shares ?? '') : '')
  const [costNav, setCostNav] = useState(initial && isFund(initial) ? String(initial.costNav ?? '') : '')
  const [grams, setGrams] = useState(initial && isGold(initial) ? String(initial.grams ?? '') : '')
  const [pricePerGram, setPricePerGram] = useState(initial && isGold(initial) ? String(initial.pricePerGram ?? '') : '')

  const [currency, setCurrency] = useState<CurrencyCode>(() => {
    if (initial && !isFund(initial)) {
      const c = (initial as { currency?: string }).currency
      if (isCurrencyCode(c)) return c
    }
    return 'CNY'
  })
  const [picker, setPicker] = useState<PickerField>(null)
  const [error, setError] = useState<string | null>(null)
  const [quote, setQuote] = useState<FundQuote | undefined>(initial && isFund(initial) ? initial.quote : undefined)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const nameTouched = useRef(false)

  const isFundKind = kind === 'fund'
  const isGoldKind = kind === 'gold'

  // 提示词：命中预设用预设，自定义分类给通用示例
  const preset = HINT_PRESETS.find((h) => h.match(category.id, category.name))
  const namePlaceholder = isFundKind
    ? '留空则自动使用基金全称'
    : preset
      ? `如 ${preset.name}`
      : isGoldKind
        ? '如 工行积存金'
        : '如 名称（可写机构或产品）'
  const notePlaceholder = preset ? `如 ${preset.note}` : '如 备注信息'

  /* ---------------- 基金代码变化：自动查询一次名称与净值 ---------------- */
  const validCode = /^\d{6}$/.test(code)

  const loadQuote = async (silent = false) => {
    if (!validCode) {
      if (!silent) setQuoteError('请输入 6 位基金代码')
      return
    }
    setQuoteLoading(true)
    setQuoteError(null)
    try {
      const map = await fetchFundQuotes([code])
      const hit = map.get(code)
      if (!hit) {
        setQuoteError('未查询到该基金')
      } else {
        setQuote(hit.quote)
        if (!nameTouched.current && !name.trim() && hit.quote.name) {
          setName(hit.quote.name)
        }
      }
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : '查询失败')
    } finally {
      setQuoteLoading(false)
    }
  }

  useEffect(() => {
    if (!isFundKind || !validCode || editing) return
    const timer = window.setTimeout(() => void loadQuote(true), 500)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, isFundKind])

  /* ---------------- 实时预览 ---------------- */
  const preview = useMemo(() => {
    if (isFundKind) {
      const s = parseAmount(shares)
      const c = parseAmount(costNav)
      if (!Number.isFinite(s) || s <= 0) return null
      const cost = s * (Number.isFinite(c) ? c : 0)
      const nav = quote?.estimatedNav ?? quote?.publishedNav
      if (nav === undefined) return { cost, value: cost, profit: 0, rate: 0, nav: undefined as number | undefined }
      const value = s * nav
      return { cost, value, profit: value - cost, rate: cost > 0 ? (value - cost) / cost : 0, nav }
    }
    if (isGoldKind) {
      const g = parseAmount(grams)
      const p = parseAmount(pricePerGram)
      if (!Number.isFinite(g) || !Number.isFinite(p)) return null
      return { cost: g * p, value: g * p, profit: 0, rate: 0, nav: undefined as number | undefined }
    }
    return null
  }, [isFundKind, isGoldKind, shares, costNav, quote, grams, pricePerGram])

  /* ---------------- 提交 ---------------- */
  const submit = () => {
    setError(null)

    if (isFundKind) {
      if (!validCode) return setError('基金代码必须是 6 位数字')
      const s = parseAmount(shares)
      if (!Number.isFinite(s) || s <= 0) return setError('持有份额必须大于 0')
      const c = parseAmount(costNav)
      if (!Number.isFinite(c) || c < 0) return setError('成本单价不能为空或负数')
      const item = makeFundItem({
        id: initial?.id,
        // 用户没填名称、且自动查询还没回来时，退回基金全称 / 代码，避免出现无名条目
        name: name.trim() || quote?.name || code,
        code,
        shares: s,
        costNav: c,
        note: note.trim() || undefined,
        quote,
      })
      // 只有用户真正手填过名称时才锁定，否则允许后续同步用接口全称补全
      item.manualName = nameTouched.current && Boolean(name.trim())
      return onSubmit(item)
    }

    if (isGoldKind) {
      const g = parseAmount(grams)
      if (!Number.isFinite(g) || g <= 0) return setError('持有克数必须大于 0')
      const p = parseAmount(pricePerGram)
      if (!Number.isFinite(p) || p <= 0) return setError('计价单价必须大于 0')
      return onSubmit(
        makeGoldItem({
          id: initial?.id,
          name: name.trim() || '黄金持仓',
          grams: g,
          pricePerGram: p,
          note: note.trim() || undefined,
          currency,
        }),
      )
    }

    const a = parseAmount(amount)
    if (!Number.isFinite(a)) return setError('请输入有效金额')
    if (a === 0) return setError('金额不能为 0')
    return onSubmit(
      makeAmountItem({ name: name.trim() || '未命名', note: note.trim() || undefined, amount: a, currency }),
    )
  }

  const nameLabel = isFundKind ? '基金名称（可自定义）' : isGoldKind ? '名称' : '名称'

  const numberField = (
    field: Exclude<PickerField, null>,
    value: string,
    onChange: (v: string) => void,
  ) => {
    const meta = FIELD_META[field]
    const parsed = parseAmount(value)
    const hint = Number.isFinite(parsed) ? scaleHint(parsed) : null
    /** 金额 / 克数 / 单价这三个字段是「原币金额」，展示量级与折算预览 */
    const showScale = field === 'amount' || field === 'grams' || field === 'pricePerGram'
    return (
      <div>
        <label className="field-label">{meta.label}</label>
        <div className="relative">
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="field-input pr-16 text-[17px] font-medium tabular-nums"
          />
          <button
            type="button"
            onClick={() => setPicker(field)}
            aria-label={`打开数字键盘输入${meta.label}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg border border-line bg-s3 p-2 text-ink3 transition hover:text-ink1"
          >
            <Calculator size={15} />
          </button>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink4">
          {meta.unit ? <span>单位：{meta.unit}</span> : null}
          {/* 量级提示：让用户一眼看出「最大那位是万还是十万」 */}
          {showScale && hint && hint.label !== '元' ? (
            <span className="rounded-full border border-line px-1.5 py-0.5 text-ink3">
              {hint.label}位
            </span>
          ) : null}
        </div>
      </div>
    )
  }

  /** 外币录入时的折算预览（人民币） */
  const convertedPreview = (() => {
    if (currency === 'CNY') return null
    const source = isFundKind ? null : isGoldKind ? grams : amount
    if (source === null) return null
    const parsed = parseAmount(source)
    if (!Number.isFinite(parsed)) return null
    const cny = toCny(parsed, currency, rates)
    return { cny, missing: cny === undefined }
  })()

  const pickerValue = (field: PickerField) => {
    switch (field) {
      case 'amount':
        return amount
      case 'shares':
        return shares
      case 'costNav':
        return costNav
      case 'grams':
        return grams
      case 'pricePerGram':
        return pricePerGram
      default:
        return ''
    }
  }
  const setPickerValue = (field: PickerField, v: string) => {
    switch (field) {
      case 'amount':
        return setAmount(v)
      case 'shares':
        return setShares(v)
      case 'costNav':
        return setCostNav(v)
      case 'grams':
        return setGrams(v)
      case 'pricePerGram':
        return setPricePerGram(v)
    }
  }

  return (
    <div className="space-y-3.5">
      {isFundKind ? (
        <div>
          <label className="field-label" htmlFor="fund-code">
            基金代码（6 位数字，填完自动查净值）
          </label>
          <div className="flex gap-2">
            <input
              id="fund-code"
              data-testid="fund-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="如 161725 招商中证白酒"
              className="field-input flex-1 tabular-nums"
            />
            <button
              type="button"
              onClick={() => void loadQuote()}
              disabled={quoteLoading || !validCode}
              className="btn-ghost shrink-0 px-3"
            >
              {quoteLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              <span className="text-[13px]">查净值</span>
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink4">
            输入 6 位代码即可，名称与净值会自动填入并持续同步（打开页面 / 每 5 分钟 / 右上角刷新）。
            <br />
            常用示例：161725 招商中证白酒、000001 华夏成长、510300 沪深300ETF
          </p>
        </div>
      ) : null}

      {/* 行情预览 */}
      {isFundKind && (quote || quoteError || quoteLoading) ? (
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          {quoteLoading ? (
            <p className="flex items-center gap-2 text-[12px] text-ink4">
              <Loader2 size={13} className="animate-spin" /> 正在获取最新估值…
            </p>
          ) : quoteError ? (
            <p className="text-[12px] tone-warn/90">{quoteError}，可先保存，稍后在详情页刷新</p>
          ) : quote ? (
            <div className="space-y-1.5">
              <p className="truncate text-[13px] font-medium text-ink2">{quote.name || code}</p>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
                {quote.estimatedNav !== undefined ? (
                  <span className="text-ink2">
                    盘中估算 <span className="font-medium tabular-nums">{formatNav(quote.estimatedNav)}</span>
                    <span className={`ml-1.5 ${(quote.estimatedRate ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                      {formatRate(quote.estimatedRate)}
                    </span>
                  </span>
                ) : (
                  <span className="text-ink4">暂无盘中估值（非交易时段 / QDII）</span>
                )}
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-ink4">
                {quote.publishedNav !== undefined ? (
                  <span>
                    最新净值 <span className="tabular-nums text-ink2">{formatNav(quote.publishedNav)}</span>
                    <span className={`ml-1.5 ${(quote.publishedRate ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                      {formatRate(quote.publishedRate)}
                    </span>
                  </span>
                ) : null}
                {quote.publishedAt ? <span>{quote.publishedAt}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {numberField(isFundKind ? 'shares' : isGoldKind ? 'grams' : 'amount', isFundKind ? shares : isGoldKind ? grams : amount, isFundKind ? setShares : isGoldKind ? setGrams : setAmount)}

      {/* 币种选择：基金是境内人民币净值，不提供切换 */}
      {!isFundKind ? (
        <div>
          <label className="field-label" htmlFor="item-currency">
            币种
          </label>
          <div className="flex items-center gap-2">
            <select
              id="item-currency"
              data-testid="item-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
              className="field-input flex-1"
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}（{c.code}）
                </option>
              ))}
            </select>
            {convertedPreview ? (
              <span
                className={`shrink-0 text-[12px] tabular-nums ${convertedPreview.missing ? 'tone-warn' : 'text-ink3'}`}
              >
                {convertedPreview.missing
                  ? '暂无汇率'
                  : `≈ ¥${formatCNY(convertedPreview.cny as number, 2)}`}
              </span>
            ) : null}
          </div>
          {currency !== 'CNY' ? (
            <p className="mt-1 text-[11px] text-ink4">
              按实时汇率折算成人民币计入总资产，汇率更新后总额会自动跟着变。
              {rates?.perCny?.[currency]
                ? ` 1 ${currency} ≈ ${(1 / (rates.perCny[currency] as number)).toFixed(4)} 元`
                : ' 暂未取到该币种汇率'}
            </p>
          ) : null}
        </div>
      ) : null}

      {isFundKind ? numberField('costNav', costNav, setCostNav) : null}
      {isGoldKind ? numberField('pricePerGram', pricePerGram, setPricePerGram) : null}

      <div>
        <label className="field-label">{nameLabel}</label>
        <input
          value={name}
          onChange={(e) => {
            nameTouched.current = true
            setName(e.target.value)
          }}
          placeholder={namePlaceholder}
          className="field-input"
        />
      </div>

      <div>
        <label className="field-label">备注（可选）</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={notePlaceholder}
          className="field-input"
        />
      </div>

      {/* 提交前预览 */}
      {preview ? (
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-ink4">当前市值</span>
            <span className="font-medium tabular-nums text-ink1">{formatCNY(preview.value)} 元</span>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[12px]">
            <span className="text-ink4">{isFundKind ? '持仓成本' : '金额'}</span>
            <span className="tabular-nums text-ink2">{formatCNY(preview.cost)} 元</span>
          </div>
          {isFundKind ? (
            <div className="mt-1.5 flex items-center justify-between text-[12px]">
              <span className="text-ink4">浮动盈亏</span>
              <span className={`font-medium tabular-nums ${preview.profit >= 0 ? 'text-up' : 'text-down'}`}>
                {formatSigned(preview.profit)} 元（{formatRate(preview.rate)}）
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-[12px] tone-danger">{error}</p> : null}

      <div className="flex items-center gap-2.5 pt-0.5">
        <button type="button" className="btn-primary flex-1" onClick={submit}>
          {editing ? '保存修改' : '添加'}
        </button>
        {editing && onDelete ? (
          <button type="button" className="btn-danger px-3.5" onClick={onDelete} aria-label="删除该条目">
            <Trash2 size={15} />
          </button>
        ) : null}
        <button type="button" className="btn-ghost px-4" onClick={onCancel}>
          取消
        </button>
      </div>

      <NumberPad
        open={picker !== null}
        label={picker ? FIELD_META[picker].label : ''}
        unit={picker ? FIELD_META[picker].unit : ''}
        quickValues={picker ? FIELD_META[picker].quick : undefined}
        value={pickerValue(picker)}
        currencyCode={isFundKind ? 'CNY' : currency}
        onChange={(v) => setPickerValue(picker, v)}
        onClose={() => setPicker(null)}
      />

      {/* 数值简要说明，帮助理解计价口径 */}
      <p className="text-[11px] leading-relaxed text-ink4">
        {isFundKind
          ? '市值 = 最新估值 × 持有份额；盈亏 = 市值 −（成本单价 × 份额）。打开页面、点击刷新或每 5 分钟会自动更新估值。'
          : isGoldKind
            ? '市值 = 克数 × 计价单价。单价可随时在详情页调整以跟踪金价变化。'
            : category.isLiability
              ? '负债类金额请填正数：该分类已标记为「计入负债」，会自动从净资产中扣减。'
              : '资产类金额填正数即计入总资产；需要抵减时可直接输入负数（如 -5000）。'}
      </p>
    </div>
  )
}
