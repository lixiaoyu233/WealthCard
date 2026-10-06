import { useMemo, useState } from 'react'
import { Check, ClipboardCopy, FileText, TriangleAlert, Upload } from 'lucide-react'
import Sheet from './Sheet'
import {
  HOLDING_IMPORT_PROMPT,
  findExistingHolding,
  parseHoldingText,
  type ExistingHolding,
  type ImportParseResult,
  type ImportType,
  type ParsedHolding,
} from '../lib/holdingImport'
import type { HoldingMarket } from '../lib/usStock'
import { enrichHolding, type Enrichment, type FundCandidate } from '../lib/fundSearch'
import { formatCNY } from '../lib/format'

interface HoldingImportSheetProps {
  open: boolean
  onClose: () => void
  /** 从哪个面板打开的：决定没写「类型」时的默认归属 */
  defaultType: ImportType
  /** 该类型要落到哪个分类 */
  targetCategory: (type: ImportType) => { id: string; name: string } | undefined
  /** 已有持仓（同代码检测重复；带上 id/份额/成本才能「合并到已有」） */
  existing: ExistingHolding[]
  /** 导入选中的行（已在组件里应用了就地修改） */
  onImport: (holdings: ParsedHolding[]) => void
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
  /** 解析后自动补全代码/份额（测试里可关掉） */
  autoEnrich?: boolean
  /** 补全实现（默认走真实接口，测试可注入） */
  enrichImpl?: typeof enrichHolding
}

const MARKET_LABEL: Record<HoldingMarket, string> = { cn: '场外基金', ashare: 'A股', hk: '港股', us: '美股' }

type DupAction = 'skip' | 'new' | 'merge'

interface Override {
  code?: string
  shares?: string
  cost?: string
  /** 金额模式（只有市值的截图）下的金额 */
  amount?: string
}

/**
 * 批量导入持仓：把「别的 AI 识别截图后输出的文本」解析成持仓。
 *
 * 三步：复制提示词 → 粘贴 AI 输出 → 解析预览（可勾选、可就地改）后导入。
 * 写入前一律先解析成表格给用户确认，不直接落库。
 */
export default function HoldingImportSheet({
  open,
  onClose,
  defaultType,
  targetCategory,
  existing,
  onImport,
  notify,
  autoEnrich = true,
  enrichImpl = enrichHolding,
}: HoldingImportSheetProps) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ImportParseResult | null>(null)
  const [excluded, setExcluded] = useState<Record<number, boolean>>({})
  const [overrides, setOverrides] = useState<Record<number, Override>>({})
  const [importDup, setImportDup] = useState(false)
  /** 每个重复行单独的处理方式 */
  const [dupAction, setDupAction] = useState<Record<number, DupAction>>({})
  /** 每行补全结果（代码/份额/成本 + 来源 + 候选） */
  const [enriched, setEnriched] = useState<Record<number, Enrichment>>({})
  const [enriching, setEnriching] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [copied, setCopied] = useState(false)

  /** 这一行最终用的代码：解析出来的，或补全得到的（重复判定必须用后者，否则永远判不出重复） */
  const codeOf = (h: ParsedHolding) => (h.code || enriched[h.line]?.code || '').trim()

  /** 与已有持仓重复的行 → 命中哪一条（用于「合并到已有」） */
  const dupEntryOf = useMemo(() => {
    const map = new Map<number, ExistingHolding>()
    for (const h of result?.holdings ?? []) {
      const hit = findExistingHolding(h, existing, codeOf(h))
      if (hit) map.set(h.line, hit)
    }
    return map
    // codeOf 依赖 enriched，所以这里要跟着重算
  }, [result, existing, enriched])

  const rows = result?.holdings ?? []
  const isSelected = (h: ParsedHolding) => {
    if (excluded[h.line] !== undefined) return !excluded[h.line]
    const dup = dupEntryOf.get(h.line)
    if (!dup) return true
    // 重复行：默认跳过；每行可以单独选「新建一条 / 合并到已有」，也可用右上开关一次性全选为「新建」
    return actionOf(h) !== 'skip'
  }

  /** 重复行的处理方式（默认跳过；开关打开则默认"新建一条"） */
  const actionOf = (h: ParsedHolding): DupAction => dupAction[h.line] ?? (importDup ? 'new' : 'skip')
  const selectedRows = rows.filter(isSelected)

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(HOLDING_IMPORT_PROMPT)
      setCopied(true)
      notify('提示词已复制，去别的 AI 粘贴 + 附上截图', 'success')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setShowPrompt(true)
      notify('浏览器不让自动复制，已展开提示词，请手动全选复制', 'error')
    }
  }

  /** 并行（限流 4）给每行补代码 / 净值 / 份额 */
  const enrichRows = async (rows: ParsedHolding[], force = false) => {
    const targets = rows.filter(
      (h) => force || !h.code || !(h.shares > 0) || h.costNav === undefined,
    )
    if (targets.length === 0) return
    setEnriching(true)
    const next: Record<number, Enrichment> = {}
    const LIMIT = 4
    for (let i = 0; i < targets.length; i += LIMIT) {
      const batch = targets.slice(i, i + LIMIT)
      const done = await Promise.all(batch.map(async (h) => ({ line: h.line, e: await enrichImpl(h) })))
      for (const { line, e } of done) next[line] = e
    }
    setEnriched((prev) => ({ ...prev, ...next }))
    setEnriching(false)
    const filled = Object.values(next).filter((e) => e.code || e.shares).length
    if (filled > 0) notify(`已补全 ${filled} 条（代码 / 份额 / 成本，来源都会标出来）`, 'success')
  }

  /** 让用户从候选里改选份额类别（A/C/I） */
  const chooseCandidate = async (row: ParsedHolding, candidate: FundCandidate) => {
    setEnriching(true)
    const e = await enrichImpl(row, { candidatesOverride: [candidate] })
    setEnriched((prev) => ({ ...prev, [row.line]: e }))
    setEnriching(false)
  }

  const runParse = () => {
    const parsed = parseHoldingText(text, { defaultType })
    setResult(parsed)
    setExcluded({})
    setOverrides({})
    setEnriched({})
    if (autoEnrich) void enrichRows(parsed.holdings)
    const { ok, warned, failed } = parsed.summary
    if (parsed.holdings.length === 0) {
      notify(failed > 0 ? `解析失败：${failed} 行有问题` : '没解析到任何持仓，检查一下格式', 'error')
      return
    }
    notify(`解析到 ${parsed.holdings.length} 条（${ok} 条干净 · ${warned} 条有提示）`, 'success')
  }

  /** 就地修改后的最终值（导入前做一次校验） */
  const finalHoldings = (): ParsedHolding[] | null => {
    const out: ParsedHolding[] = []
    for (const h of selectedRows) {
      const ov = overrides[h.line] ?? {}
      const code = (ov.code ?? h.code).trim()
      const e = enriched[h.line]
      // 金额模式（平台总览页只有名称+金额）：
      // 补全拿到了份额就升级成「持仓」，否则按金额记账（之后再补）
      if (h.mode === 'amount') {
        const amountText = ov.amount ?? String(h.amount ?? '')
        const amount = Number(amountText.replace(/[^\d.]/g, ''))
        if (!Number.isFinite(amount) || amount <= 0) {
          notify(`第 ${h.line} 行：金额必须大于 0`, 'error')
          return null
        }
        const finalCode = code || e?.code || ''
        if (!(h.name ?? '').trim() && !finalCode) {
          notify(`第 ${h.line} 行：至少要有一个名称或代码`, 'error')
          return null
        }
        const derivedShares = e?.shares ?? 0
        const mergeTarget = dupEntryOf.get(h.line)
        const mergeInto = mergeTarget && actionOf(h) === 'merge' ? mergeTarget.id : undefined
        if (derivedShares > 0) {
          out.push({
            ...h,
            mode: 'holding',
            code: finalCode,
            amount,
            shares: derivedShares,
            costNav: e?.costNav,
            mergeInto,
            // ⚠️ 必须把补全到的「当前净值」带上：否则估值只能退回成本，
            // 市值会显示成 份额×成本（如 10.00），盈亏恒为 0
            price: h.price ?? e?.nav,
            sources: {
              code: e?.sources.code ?? 'none',
              shares: e?.sources.shares ?? 'none',
              cost: e?.sources.cost ?? 'none',
            },
          })
        } else {
          out.push({ ...h, code: finalCode, amount, shares: 0 })
        }
        continue
      }
      const shares =
        ov.shares !== undefined
          ? Number(ov.shares.replace(/[^\d.]/g, ''))
          : h.shares > 0
            ? h.shares
            : (e?.shares ?? 0)
      const cost =
        ov.cost !== undefined
          ? ov.cost.trim() === ''
            ? undefined
            : Number(ov.cost.replace(/[^\d.]/g, ''))
          : (h.costNav ?? e?.costNav)
      const finalCode = code || (e?.code ?? '')
      if (!finalCode) {
        notify(`第 ${h.line} 行：代码不能为空`, 'error')
        return null
      }
      if (!Number.isFinite(shares) || shares <= 0) {
        notify(`第 ${h.line} 行：份额必须大于 0`, 'error')
        return null
      }
      if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) {
        notify(`第 ${h.line} 行：成本必须是非负数`, 'error')
        return null
      }
      const mergeTarget = dupEntryOf.get(h.line)
      out.push({
        ...h,
        code: finalCode,
        shares,
        costNav: cost,
        price: h.price ?? e?.nav ?? h.price,
        mergeInto: mergeTarget && actionOf(h) === 'merge' ? mergeTarget.id : undefined,
        sources: e?.sources ?? h.sources,
      })
    }
    return out
  }

  const submit = () => {
    const list = finalHoldings()
    if (!list) return
    const missing = list.find((h) => !targetCategory(h.type))
    if (missing) {
      notify(`找不到要导入的分类（${missing.type === 'fund' ? '基金' : '股票'}），请先建一个`, 'error')
      return
    }
    onImport(list)
  }

  const setOverride = (line: number, patch: Override) =>
    setOverrides((prev) => ({ ...prev, [line]: { ...prev[line], ...patch } }))

  // 它是从「分类详情」里开出来的，层级要比详情高一层
  return (
    <Sheet
      open={open}
      title="批量导入持仓"
      subtitle="把别的 AI 识别截图的结果粘进来，先预览再导入"
      onClose={onClose}
      zClassName="z-[60]"
      leading={
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-s3 text-ink2">
          <Upload size={16} />
        </span>
      }
      footer={
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid="holding-import-submit"
            className="btn-primary flex-1"
            disabled={selectedRows.length === 0}
            onClick={submit}
          >
            导入选中的 {selectedRows.length} 条
          </button>
          <button type="button" className="btn-ghost px-4" onClick={onClose}>
            取消
          </button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="holding-import">
        {/* 第一步：提示词 */}
        <div className="rounded-2xl border border-line bg-s2 px-3.5 py-3">
          <p className="text-[12px] leading-relaxed text-ink3">
            <span className="font-medium text-ink2">第 1 步</span>：复制提示词，连同
            <span className="text-ink2">持仓截图</span>发给别的 AI（能看图的），让它按格式输出一段文字。
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="holding-import-copy-prompt"
              className="btn-ghost px-3 py-1.5 text-[12px]"
              onClick={() => void copyPrompt()}
            >
              {copied ? <Check size={13} /> : <ClipboardCopy size={13} />} 复制提示词
            </button>
            <button
              type="button"
              className="text-[11.5px] text-ink4 underline-offset-2 hover:underline"
              onClick={() => setShowPrompt((v) => !v)}
            >
              {showPrompt ? '收起提示词' : '查看提示词'}
            </button>
          </div>
          {showPrompt ? (
            <textarea
              readOnly
              data-testid="holding-import-prompt"
              value={HOLDING_IMPORT_PROMPT}
              className="field-input mt-2 h-40 w-full resize-none text-[11.5px] leading-relaxed"
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : null}
          <p className="mt-2 text-[11px] leading-relaxed tone-warn">
            截图里要能看到：名称或代码 + 持有份额 + 成本（单价或总额）。缺了的话 AI 会告诉你缺什么。
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-ink4">
            隐私提醒：截图包含你的持仓明细，交给哪家 AI 由你决定。
          </p>
        </div>

        {/* 第二步：粘贴 */}
        <div>
          <p className="text-[12px] leading-relaxed text-ink3">
            <span className="font-medium text-ink2">第 2 步</span>：把 AI 输出的文字粘到这里
          </p>
          <textarea
            data-testid="holding-import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'类型=基金 代码=161725 名称=招商中证白酒 份额=12000 成本单价=1.2345'}
            className="field-input mt-2 h-32 w-full resize-none text-[12px] leading-relaxed"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              data-testid="holding-import-parse"
              className="btn-primary px-4 py-1.5 text-[12px]"
              disabled={!text.trim()}
              onClick={runParse}
            >
              解析
            </button>
            {result ? (
              <span className="text-[11.5px] text-ink4" data-testid="holding-import-summary">
                {result.summary.total} 条：可导入 {result.summary.ok} · 有提示 {result.summary.warned} · 错误{' '}
                {result.summary.failed}
              </span>
            ) : null}
          </div>
        </div>

        {/* 注释行：AI 的「# 缺少：…」「# 存疑：…」 */}
        {result && result.notes.length > 0 ? (
          <div className="rounded-2xl border border-line bg-s2 px-3.5 py-2.5" data-testid="holding-import-notes">
            <p className="text-[11.5px] font-medium text-ink3">AI 的说明</p>
            <ul className="mt-1 space-y-0.5">
              {result.notes.map((n, i) => (
                <li key={i} className="text-[11.5px] leading-relaxed text-ink4">
                  {n}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 错误行 */}
        {result && result.failed.length > 0 ? (
          <div className="rounded-2xl border border-line bg-s2 px-3.5 py-2.5">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium tone-danger">
              <TriangleAlert size={13} /> 这些行有问题，不会导入
            </p>
            <ul className="mt-1 space-y-0.5">
              {result.failed.map((f) => (
                <li key={f.line} className="text-[11.5px] leading-relaxed tone-danger" data-testid={`holding-import-error-${f.line}`}>
                  第 {f.line} 行：{f.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 第三步：预览 + 勾选 + 就地改 */}
        {rows.length > 0 ? (
          <div>
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-ink3">
                <span className="font-medium text-ink2">第 3 步</span>：核对后导入
              </p>
              {dupEntryOf.size > 0 ? (
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink4">
                  <input
                    type="checkbox"
                    data-testid="holding-import-allow-dup"
                    checked={importDup}
                    onChange={(e) => {
                      setImportDup(e.target.checked)
                      setDupAction({}) // 一键统一，清掉逐行的单独选择
                    }}
                    className="h-3.5 w-3.5 accent-brand"
                  />
                  已存在的也新建（{dupEntryOf.size} 条）
                </label>
              ) : null}
            </div>
            <ul className="mt-2 space-y-2">
              {rows.map((h) => {
                const ov = overrides[h.line] ?? {}
                const dup = dupEntryOf.get(h.line)
                const target = targetCategory(h.type)
                return (
                  <li
                    key={h.line}
                    data-testid={`holding-import-row-${h.line}`}
                    className="rounded-2xl border border-line bg-s2 px-3.5 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        data-testid={`holding-import-check-${h.line}`}
                        checked={isSelected(h)}
                        onChange={(e) => setExcluded((prev) => ({ ...prev, [h.line]: !e.target.checked }))}
                        className="mt-1 h-4 w-4 shrink-0 accent-brand"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink1">
                          <span className="chip">{h.mode === 'amount' ? '按金额' : MARKET_LABEL[h.market]}</span>
                          <span>{h.name || '（名称待补全）'}</span>
                          {dup ? (
                            <span className="chip tone-warn" data-testid={`holding-import-dup-${h.line}`}>
                              已存在
                            </span>
                          ) : null}
                        </p>
                        {dup ? (
                          <div className="mt-1 flex items-center gap-1">
                            {(
                              [
                                ['skip', '跳过'],
                                ['new', '新建一条'],
                                ['merge', '合并到已有'],
                              ] as Array<[DupAction, string]>
                            ).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                data-testid={`holding-import-dup-${value}-${h.line}`}
                                onClick={() => setDupAction((prev) => ({ ...prev, [h.line]: value }))}
                                className={`rounded-lg border px-2 py-0.5 text-[11px] transition ${
                                  actionOf(h) === value
                                    ? 'border-line-strong bg-s3 text-ink1'
                                    : 'border-line bg-s2 text-ink4 hover:bg-s3'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                            <span className="ml-1 text-[10.5px] text-ink4">
                              已有 {dupEntryOf.get(h.line)?.name ?? dupEntryOf.get(h.line)?.code} ·{' '}
                              {dupEntryOf.get(h.line)?.shares ?? 0} 份
                            </span>
                          </div>
                        ) : null}
                        <p className="hidden">
                          <span className="text-[11px] text-ink4">→ {target?.name ?? '缺分类'}</span>
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <input
                            data-testid={`holding-import-code-${h.line}`}
                            value={ov.code ?? h.code}
                            onChange={(e) => setOverride(h.line, { code: e.target.value })}
                            placeholder={h.mode === 'amount' ? '代码（可留空）' : '代码'}
                            className="field-input w-24 py-1 text-[11.5px] tabular-nums"
                          />
                          {h.mode === 'amount' ? (
                            <>
                              <input
                                data-testid={`holding-import-amount-${h.line}`}
                                value={ov.amount ?? String(h.amount ?? '')}
                                onChange={(e) => setOverride(h.line, { amount: e.target.value })}
                                aria-label="持仓金额"
                                placeholder="持仓金额"
                                className="field-input w-24 py-1 text-[11.5px] tabular-nums"
                              />
                              <span className="text-[11px] text-ink4">仅按金额记账 · 之后再补份额</span>
                            </>
                          ) : null}
                          <input
                            data-testid={`holding-import-shares-${h.line}`}
                            value={ov.shares ?? String(h.shares)}
                            onChange={(e) => setOverride(h.line, { shares: e.target.value })}
                            className="field-input w-24 py-1 text-[11.5px] tabular-nums"
                            aria-label="份额"
                          />
                          <input
                            data-testid={`holding-import-cost-${h.line}`}
                            value={ov.cost ?? (h.costNav !== undefined ? String(h.costNav) : '')}
                            onChange={(e) => setOverride(h.line, { cost: e.target.value })}
                            placeholder="成本单价"
                            className={`field-input w-24 py-1 text-[11.5px] tabular-nums ${h.mode === 'amount' ? 'hidden' : ''}`}
                            aria-label="成本单价"
                          />
                          <span className="text-[11px] text-ink4">
                            {h.mode === 'amount'
                              ? '（只有金额，无份额/成本）'
                              : `市值 ≈ ${formatCNY(h.shares * (h.costNav ?? 0), 2)}`}
                          </span>
                        </div>
                        {/* 自动补全的结果与来源 */}
                        {enriched[h.line] ? (
                          <div className="mt-1 space-y-0.5" data-testid={`holding-import-enriched-${h.line}`}>
                            {/* 代码：自动选中的显示来源；不够像的只给候选让用户选（不自动采用） */}
                            {!h.code &&
                            enriched[h.line].candidates &&
                            enriched[h.line].candidates!.length > 0 ? (
                              <p className="flex flex-wrap items-center gap-1 text-[11px] text-ink4">
                                {enriched[h.line].code ? (
                                  <span>
                                    代码{' '}
                                    <span className="tabular-nums text-ink2">{enriched[h.line].code}</span> · 按名称搜到
                                    {enriched[h.line].officialName ? `（${enriched[h.line].officialName}）` : ''}
                                  </span>
                                ) : (
                                  <span>候选里没有足够接近的名字，请自己选一个：</span>
                                )}
                                <select
                                  data-testid={`holding-import-candidate-${h.line}`}
                                  className="max-w-[220px] rounded border border-line bg-s2 px-1 py-0.5 text-[11px]"
                                  value={enriched[h.line].code ?? ''}
                                  onChange={(ev) => {
                                    const picked = enriched[h.line].candidates?.find((c) => c.code === ev.target.value)
                                    if (picked) void chooseCandidate(h, picked)
                                  }}
                                >
                                  <option value="">请选择</option>
                                  {enriched[h.line].candidates!.map((c) => (
                                    <option key={c.code} value={c.code}>
                                      {c.code} {c.name}
                                    </option>
                                  ))}
                                </select>
                              </p>
                            ) : null}
                            {enriched[h.line].shares && !(h.shares > 0) ? (
                              <p className="text-[11px] text-ink4">
                                份额{' '}
                                <span className="tabular-nums text-ink2">
                                  {enriched[h.line].shares!.toFixed(2)}
                                </span>{' '}
                                · 由市值推算
                                {enriched[h.line].navDate ? `（净值日期 ${enriched[h.line].navDate}）` : ''}
                              </p>
                            ) : null}
                            {enriched[h.line].costNav !== undefined && h.costNav === undefined ? (
                              <p className="text-[11px] text-ink4">
                                成本单价{' '}
                                <span className="tabular-nums text-ink2">
                                  {enriched[h.line].costNav!.toFixed(4)}
                                </span>{' '}
                                ·{' '}
                                {enriched[h.line].sources.cost === 'derived-profit'
                                  ? '由持仓收益反推'
                                  : '按净值兜底（盈亏按 0）'}
                              </p>
                            ) : null}
                            {enriched[h.line].notes.map((n, i) => (
                              <p key={i} className="text-[11px] leading-relaxed tone-warn">
                                {n}
                              </p>
                            ))}
                          </div>
                        ) : enriching ? (
                          <p className="mt-1 text-[11px] text-ink4">补全代码 / 份额中…</p>
                        ) : null}

                        {h.issues.length > 0 ? (
                          <ul className="mt-1 space-y-0.5">
                            {h.issues.map((issue, i) => (
                              <li key={i} className="text-[11px] leading-relaxed tone-warn">
                                {issue.message}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}

        {!result && text.trim() === '' ? (
          <p className="flex items-start gap-1.5 rounded-2xl border border-dashed border-line px-3.5 py-3 text-[11.5px] leading-relaxed text-ink4">
            <FileText size={13} className="mt-0.5 shrink-0" />
            支持：一行一个标的（键=值）、字段顺序随意、千分位与货币符号、以及 Markdown 表格。
            AI 写的 <span className="text-ink3">#</span> 注释会被忽略，但会显示给你看。
          </p>
        ) : null}
      </div>
    </Sheet>
  )
}
