import { useEffect, useMemo, useState } from 'react'
import { Check, Landmark, Plus, Trash2, TrendingUp } from 'lucide-react'
import type { Portfolio } from '../types/asset'
import type { AppSettings, CashCandidate, FundingSource } from '../lib/settings'
import { currentMonth, formatMonth, isPaydayReached } from '../lib/settings'
import { formatCNY } from '../lib/format'
import Sheet from './Sheet'

interface SettingsSheetProps {
  open: boolean
  settings: AppSettings
  portfolio: Portfolio
  candidates: CashCandidate[]
  onClose: () => void
  onSetFundDefault: (patch: Partial<AppSettings['fund']>) => void
  onSetFundingSource: (source: FundingSource | undefined) => void
  onSetTrendsEnabled: (v: boolean) => void
  onSetFixed: (patch: Partial<AppSettings['salary']['fixed']>) => void
  onUpsertSalary: (month: string, amount: number) => void
  onRemoveSalary: (month: string) => void
  onApplySalary: (month: string) => { ok: boolean; message: string }
}

type Tab = 'fund' | 'salary'

export default function SettingsSheet(props: SettingsSheetProps) {
  const { open, onClose, portfolio } = props
  const [tab, setTab] = useState<Tab>('fund')

  useEffect(() => {
    if (open) setTab('fund')
  }, [open])

  const cashCategories = portfolio.categories.filter((c) => !c.isLiability && c.items.some((i) => i.kind === 'amount'))

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="设置"
      subtitle={tab === 'fund' ? '基金申购的资金来源' : '薪资记录与固定发薪'}
      leading={
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s2 text-ink2">
          <TrendingUp size={17} />
        </span>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-line bg-s2 p-1">
        {(
          [
            ['fund', '基金申购'],
            ['salary', '薪资'],
          ] as Array<[Tab, string]>
        ).map(([key, labelText]) => (
          <button
            key={key}
            type="button"
            data-testid={`settings-tab-${key}`}
            onClick={() => setTab(key)}
            className={`rounded-lg py-2 text-[13px] transition ${
              tab === key ? 'bg-invert text-on-invert' : 'text-ink3 hover:text-ink1'
            }`}
          >
            {labelText}
          </button>
        ))}
      </div>

      {tab === 'fund' ? (
        <FundTab {...props} cashCategories={cashCategories} />
      ) : (
        <SalaryTab {...props} />
      )}

      {/* 设置面板底部也提示数据只存本地 */}
      <p className="mt-5 border-t border-line pt-3 text-[11px] leading-relaxed text-ink4">
        设置与资产数据分开保存在本机浏览器，不会上传。
      </p>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ *
 * 基金申购
 * ------------------------------------------------------------------ */

function SourcePicker({
  candidates,
  value,
  onChange,
  testId,
}: {
  candidates: CashCandidate[]
  value?: FundingSource
  onChange: (s: FundingSource | undefined) => void
  testId: string
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, CashCandidate[]>()
    for (const c of candidates) {
      if (!m.has(c.categoryId)) m.set(c.categoryId, [])
      m.get(c.categoryId)!.push(c)
    }
    return [...m.entries()]
  }, [candidates])

  if (candidates.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12px] leading-relaxed text-ink4">
        还没有可作为资金来源的项目。先到「现金与固定资产」里添加一个金额类条目（如「招行活期」），
        之后就能在这里选它来划拨。
      </p>
    )
  }

  return (
    <select
      data-testid={testId}
      value={value?.itemId ?? ''}
      onChange={(e) => {
        const id = e.target.value
        const hit = candidates.find((c) => c.itemId === id)
        onChange(hit ? { categoryId: hit.categoryId, itemId: hit.itemId, itemName: hit.itemName } : undefined)
      }}
      className="field-input"
    >
      <option value="">请选择项目</option>
      {grouped.map(([catId, list]) => (
        <optgroup key={catId} label={list[0]?.categoryName ?? ''}>
          {list.map((c) => (
            <option key={c.itemId} value={c.itemId}>
              {c.itemName}（余额 {formatCNY(c.amount, 0)}）
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

function FundTab({
  settings,
  candidates,
  onSetFundDefault,
  onSetFundingSource,
}: SettingsSheetProps & { cashCategories: unknown }) {
  return (
    <div className="space-y-5">
      <div>
        <p className="field-label">基金申购默认方式</p>
        <div className="space-y-2">
          {(
            [
              [false, '直接添加', '只增加基金持仓，现金余额不变'],
              [true, '从现有项目划拨', '基金 +X，所选现金项 −X，净资产不变'],
            ] as Array<[boolean, string, string]>
          ).map(([useFunding, title, desc]) => {
            const active = settings.fund.useFunding === useFunding
            return (
              <button
                key={String(useFunding)}
                type="button"
                data-testid={`fund-default-${useFunding ? 'funding' : 'direct'}`}
                onClick={() => onSetFundDefault({ useFunding })}
                className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                  active ? 'border-line-strong bg-s3' : 'border-line bg-s2 hover:bg-s3'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="flex-1 text-[13.5px] font-medium text-ink1">{title}</span>
                  {active ? <Check size={15} className="tone-down" /> : null}
                </span>
                <span className="mt-1 block text-[11.5px] leading-relaxed text-ink4">{desc}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <p className="field-label">默认扣款项目</p>
        <SourcePicker
          testId="settings-funding-source"
          candidates={candidates}
          value={settings.fund.lastFundingSource}
          onChange={onSetFundingSource}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
          这里选定后，添加基金时会自动带出（每次仍可临时改）。扣款后该项目的余额会相应减少，
          所以净资产保持不变——钱只是从现金变成了基金。
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 薪资
 * ------------------------------------------------------------------ */

function SalaryTab({
  settings,
  candidates,
  onSetTrendsEnabled,
  onSetFixed,
  onUpsertSalary,
  onRemoveSalary,
  onApplySalary,
}: SettingsSheetProps) {
  const month = currentMonth()
  const existing = settings.salary.records.find((r) => r.month === month)
  const [draft, setDraft] = useState('')
  const [fixedDraft, setFixedDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    setDraft(existing ? String(existing.amount) : '')
  }, [existing?.amount, existing?.month])

  useEffect(() => {
    setFixedDraft(settings.salary.fixed.amount ? String(settings.salary.fixed.amount) : '')
  }, [settings.salary.fixed.amount])

  const saveMonth = () => {
    const v = Number(draft.replace(/[,\s]/g, ''))
    if (!Number.isFinite(v) || v <= 0) {
      setMessage('请输入大于 0 的金额')
      return
    }
    onUpsertSalary(month, v)
    setMessage(`已记录 ${formatMonth(month)}：${formatCNY(v)} 元`)
  }

  const saveFixed = () => {
    const v = Number(fixedDraft.replace(/[,\s]/g, ''))
    if (!Number.isFinite(v) || v <= 0) {
      setMessage('固定薪资金额需要大于 0')
      return
    }
    onSetFixed({ amount: v })
    setMessage(`固定薪资已设为 ${formatCNY(v)} 元 / 月`)
  }

  const applyNow = () => {
    const r = onApplySalary(month)
    setMessage(r.message)
  }

  return (
    <div className="space-y-5">
      {/* 本月薪资 */}
      <div>
        <p className="field-label">本月薪资（{formatMonth(month)}）</p>
        <div className="flex gap-2">
          <input
            data-testid="salary-month-amount"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            placeholder="如 20000"
            className="field-input flex-1 tabular-nums"
          />
          <button type="button" data-testid="salary-save" className="btn-primary shrink-0 px-4" onClick={saveMonth}>
            保存
          </button>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink4">
          只记录年月与金额，存档后可随时回看走势；修改金额会把该月标记为「未入账」，需要重新写入。
        </p>
        {existing ? (
          <div className="mt-2 flex items-center gap-2 rounded-xl border border-line bg-s2 px-3.5 py-2.5 text-[12px]">
            <span className="text-ink3">
              {formatMonth(existing.month)} · {formatCNY(existing.amount)} 元
            </span>
            <span className={`ml-auto ${existing.applied ? 'tone-down' : 'tone-warn'}`}>
              {existing.applied ? '已入账' : '未入账'}
            </span>
            {!existing.applied ? (
              <button type="button" data-testid="salary-apply" className="btn-ghost px-3 py-1.5 text-[12px]" onClick={applyNow}>
                写入现金项
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 固定薪资 */}
      <div className="border-t border-line pt-4">
        <label className="flex cursor-pointer items-center justify-between">
          <span>
            <span className="block text-[13.5px] font-medium text-ink1">固定薪资</span>
            <span className="mt-0.5 block text-[11.5px] text-ink4">
              填一次金额与发薪日，之后每月到点自动记入指定项目（不会重复入账）
            </span>
          </span>
          <input
            type="checkbox"
            data-testid="salary-fixed-enabled"
            checked={settings.salary.fixed.enabled}
            onChange={(e) => onSetFixed({ enabled: e.target.checked })}
            className="h-4 w-4 accent-brand"
          />
        </label>

        {settings.salary.fixed.enabled ? (
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="field-label" htmlFor="fixed-amount">
                  每月金额
                </label>
                <input
                  id="fixed-amount"
                  data-testid="salary-fixed-amount"
                  value={fixedDraft}
                  onChange={(e) => setFixedDraft(e.target.value)}
                  inputMode="decimal"
                  placeholder="如 20000"
                  className="field-input tabular-nums"
                />
              </div>
              <div className="w-[104px]">
                <label className="field-label" htmlFor="fixed-payday">
                  发薪日
                </label>
                <input
                  id="fixed-payday"
                  data-testid="salary-fixed-payday"
                  value={String(settings.salary.fixed.payday)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''))
                    onSetFixed({ payday: Number.isFinite(n) && n > 0 ? Math.min(28, n) : 1 })
                  }}
                  inputMode="numeric"
                  className="field-input tabular-nums"
                />
              </div>
              <button type="button" className="btn-ghost mt-6 shrink-0 px-3" onClick={saveFixed}>
                保存
              </button>
            </div>

            <div>
              <p className="field-label">发薪后写入哪个项目</p>
              <SourcePicker
                testId="salary-fixed-target"
                candidates={candidates}
                value={settings.salary.fixed.target}
                onChange={(s) => onSetFixed({ target: s })}
              />
              {settings.salary.fixed.target ? (
                <p className="mt-1.5 text-[11px] text-ink4">
                  到达每月 {settings.salary.fixed.payday} 日后，会把这笔钱加到
                  「{settings.salary.fixed.target.itemName}」；若该月已入账则跳过。
                  {isPaydayReached(settings.salary.fixed.payday)
                    ? '（本月已到发薪日）'
                    : `（本月 ${settings.salary.fixed.payday} 日仍未到）`}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* 走势面板开关（与薪资历史共用一个面板） */}
      <div className="border-t border-line pt-4">
        <label className="flex cursor-pointer items-center justify-between">
          <span>
            <span className="block text-[13.5px] font-medium text-ink1">在主界面显示走势</span>
            <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink4">
              净资产 / 总资产 / 负债 / 薪资 四合一；按天记录、按月聚合，默认关闭
            </span>
          </span>
          <input
            type="checkbox"
            data-testid="trends-enabled"
            checked={settings.trendsEnabled}
            onChange={(e) => onSetTrendsEnabled(e.target.checked)}
            className="h-4 w-4 accent-brand"
          />
        </label>
      </div>

      {/* 历史记录 */}
      {settings.salary.records.length > 0 ? (
        <div className="border-t border-line pt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="field-label mb-0">历史记录</p>
            <span className="text-[11px] text-ink4">共 {settings.salary.records.length} 个月</span>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {[...settings.salary.records].reverse().map((rec) => (
              <li key={rec.month} className="flex items-center gap-2 bg-s2 px-3.5 py-2.5">
                <span className="text-[12.5px] text-ink2">{formatMonth(rec.month)}</span>
                <span className="ml-auto text-[12.5px] tabular-nums text-ink1">{formatCNY(rec.amount)}</span>
                <span className={`w-[52px] text-right text-[11px] ${rec.applied ? 'tone-down' : 'text-ink4'}`}>
                  {rec.applied ? '已入账' : '仅记录'}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveSalary(rec.month)}
                  aria-label={`删除 ${rec.month} 记录`}
                  className="shrink-0 rounded-full p-1.5 text-ink4 transition hover:bg-danger/10 hover:tone-danger"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <p className="flex items-center gap-1.5 text-[12px] tone-info" data-testid="salary-message">
          <Plus size={12} /> {message}
        </p>
      ) : null}

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink4">
        <Landmark size={12} className="mt-0.5 shrink-0" />
        固定薪资的自动入账在「打开应用时」检查：到发薪日且当月未入账才会执行一次，
        重新打开也不会重复加钱。
      </p>
    </div>
  )
}
