import { describe, expect, it } from 'vitest'
import {
  buildShareBonusUrl,
  fetchAshareDividends,
  normalizeShareBonusRow,
  parseAfterTaxPer10,
} from './dividendService'

const skipApi = process.env.ACW_SKIP_API === '1'

describe('parseAfterTaxPer10', () => {
  it('从公告文本里解析「扣税后 X 元」', () => {
    expect(parseAfterTaxPer10('10转4股派15.00元(含税,扣税后13.50元)')).toBe(13.5)
    expect(parseAfterTaxPer10('10派0.65元(含税,扣税后0.585元)')).toBe(0.585)
  })
  it('解析不到就返回 undefined（不猜）', () => {
    expect(parseAfterTaxPer10('10派1元')).toBeUndefined()
    expect(parseAfterTaxPer10(undefined)).toBeUndefined()
  })
})

describe('normalizeShareBonusRow：每 10 股 → 每股', () => {
  const row = {
    SECURITY_CODE: '002023',
    SECURITY_NAME_ABBR: '海特高新',
    EX_DIVIDEND_DATE: '2026-10-08 00:00:00',
    EQUITY_RECORD_DATE: '2026-09-30 00:00:00',
    PLAN_NOTICE_DATE: '2026-08-21 00:00:00',
    PRETAX_BONUS_RMB: 0.65,
    BONUS_IT_RATIO: null,
    IMPL_PLAN_PROFILE: '10派0.65元(含税,扣税后0.585元)',
  }

  it('金额换算成每股，日期归一化，id 幂等', () => {
    const rec = normalizeShareBonusRow(row)!
    expect(rec.code).toBe('002023')
    expect(rec.market).toBe('ashare')
    expect(rec.exDate).toBe('2026-10-08')
    expect(rec.recordDate).toBe('2026-09-30')
    expect(rec.declarationDate).toBe('2026-08-21')
    expect(rec.cashPerUnit).toBeCloseTo(0.065, 8)
    expect(rec.afterTaxPerUnit).toBeCloseTo(0.0585, 8)
    expect(rec.currency).toBe('CNY')
    expect(rec.source).toBe('auto')
    expect(rec.id).toBe('auto_ashare:002023_2026-10-08')
  })

  it('送转比例带出来；没有就不填', () => {
    expect(normalizeShareBonusRow({ ...row, BONUS_IT_RATIO: 4 })!.bonusRatio).toBe(4)
    expect(normalizeShareBonusRow(row)!.bonusRatio).toBeUndefined()
  })

  it('没有除息日的「预案」记录会被跳过（没有日期就没法进日历）', () => {
    expect(normalizeShareBonusRow({ ...row, EX_DIVIDEND_DATE: null })).toBeNull()
  })

  it('代码或日期不合法返回 null', () => {
    expect(normalizeShareBonusRow({ ...row, SECURITY_CODE: '6005' })).toBeNull()
    expect(normalizeShareBonusRow({ ...row, EX_DIVIDEND_DATE: '待定' })).toBeNull()
  })
})

describe('buildShareBonusUrl', () => {
  it('一次查多只，过滤条件正确编码', () => {
    const url = buildShareBonusUrl(['600519', '000001'], 1)
    expect(url).toContain('reportName=RPT_SHAREBONUS_DET')
    // URLSearchParams 把空格编成 +，解码后还原再比对
    const decoded = decodeURIComponent(url).replace(/\+/g, ' ')
    expect(decoded).toContain('(SECURITY_CODE in ("600519","000001"))')
    expect(decoded).toContain('sortColumns=EX_DIVIDEND_DATE')
  })
})

describe.skipIf(skipApi)('真实接口：A股分红（含未来已公告）', () => {
  it('能拉到 600519 的分红，且字段可解析', async () => {
    const records = await fetchAshareDividends(['600519'])
    expect(records.length).toBeGreaterThan(0)
    const first = records[0]
    expect(first.market).toBe('ashare')
    expect(first.exDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(first.cashPerUnit).toBeGreaterThan(0)
  }, 20_000)

  it('能拿到「未来」已公告的除权除息日（不只是历史）', async () => {
    const records = await fetchAshareDividends(['600519', '000001', '002023', '601390'])
    const today = new Date().toISOString().slice(0, 10)
    const future = records.filter((r) => r.exDate > today)
    expect(future.length).toBeGreaterThan(0)
  }, 20_000)
})
