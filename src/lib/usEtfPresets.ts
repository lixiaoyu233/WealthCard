/**
 * 美股 / 港股上市 ETF 的内置预设。
 *
 * 为什么需要它：东财只覆盖**中国上市**的基金/ETF，美股/港股上市的 ETF（SPY/BND/GLD…）
 * 拿不到资产配置数据。只靠名称关键词能判大类（Bond/Gold…），但
 * ① 很多官方名里没有关键词；② 混合型（AOA 股债 80/20）名称里根本没比例。
 *
 * 这里放一张**代码 → 资产占比**的小表：命中即精确，未命中再退回名称关键词/形态。
 * 用「分组 + 元组」写，源码体积很小（100 条 ≈ 1 KB），运行时只在 us/hk 标的上查一次。
 *
 * 占比向量固定顺序：股票 / 债券 / 现金 / 黄金 / 大宗商品 / 其他
 */
import type { AssetMix } from '../types/strategy'

type MixTuple = [number, number, number, number, number, number]

const mix = (t: MixTuple): AssetMix => ({
  equity: t[0],
  bond: t[1],
  money: t[2],
  gold: t[3],
  commodity: t[4],
  other: t[5],
})

const EQ: MixTuple = [1, 0, 0, 0, 0, 0]
const BOND: MixTuple = [0, 1, 0, 0, 0, 0]
const MONEY: MixTuple = [0, 0, 1, 0, 0, 0]
const GOLD: MixTuple = [0, 0, 0, 1, 0, 0]
const COMMODITY: MixTuple = [0, 0, 0, 0, 1, 0]
const OTHER: MixTuple = [0, 0, 0, 0, 0, 1]
/** 目标风险型（股/债 混合）：名称里通常没有比例，这里写死常见组合 */
const MIX_80_20: MixTuple = [0.8, 0.2, 0, 0, 0, 0]
const MIX_60_40: MixTuple = [0.6, 0.4, 0, 0, 0, 0]
const MIX_40_60: MixTuple = [0.4, 0.6, 0, 0, 0, 0]
const MIX_30_70: MixTuple = [0.3, 0.7, 0, 0, 0, 0]

/** 同一个占比向量 + 一串代码 → 表项（这样源码里每个代码只占几个字符） */
const group = (t: MixTuple, codes: string): Array<[string, MixTuple]> =>
  codes
    .split(/\s+/)
    .filter(Boolean)
    .map((code) => [code, t] as [string, MixTuple])

const ENTRIES: Array<[string, MixTuple]> = [
  // ---- 股票：美国宽基 / 行业 / 因子 ----
  ...group(
    EQ,
    `SPY VOO IVV VTI ITOT SCHB SCHX VV RSP QQQ QQQM IWM DIA MDY IJH IJR
     XLK XLF XLE XLV XLI XLP XLY XLU XLB XLC
     SCHD VYM DVY VIG VUG VTV IWD IWF MTUM QUAL USMV SPLG SPMD
     ARKK ARKG ARKW SOXX SMH XBI IBB KRE KBE ITA XAR XOP XME GDX GDXJ`,
  ),
  // ---- 股票：国际 / 新兴（海外股票仍算股票）----
  ...group(EQ, `VEA VWO IEFA IEMG EFA EEM VXUS IXUS EWJ EWG EWU FXI MCHI INDA EWZ EWY EWT EWA VGK VPL SCZ`),
  // ---- 债券（默认中期）----
  ...group(
    BOND,
    `BND AGG BNDX IEF IEI SHY LQD VCIT VCSH VGIT VGLT HYG JNK TIP VTIP MUB MBB EMB
     BIV BSV IGIB IGOV SCHZ SPAB SPSB SPIB IUSB FLOT FALN ANGL`,
  ),
  // ---- 债券：长久期（覆盖默认的中期）----
  ...group(BOND, `TLT EDV ZROZ SPTL BLV VCLT SCHQ`),
  // ---- 现金 / 超短债 ----
  ...group(MONEY, `SHV BIL SGOV USFR TFLO GBIL ICSH NEAR`),
  // ---- 黄金 / 贵金属 ----
  ...group(GOLD, `GLD IAU GLDM SGOL SLV SIVR PPLT PALL AAAU BAR`),
  // ---- 大宗商品 ----
  ...group(COMMODITY, `USO UNG DBA DBC PDBC GSG DJP BNO UGA CPER`),
  // ---- 其他：REITs（不动产）+ 加密 / 波动率 / 另类 ----
  // 三个内置策略都没有「不动产」桶，所以 REITs 算其他，界面上会明确标「未归类」
  ...group(OTHER, `VNQ SCHH IYR RWR VNQI XLRE BITO GBTC IBIT FBTC ARKB VIXY VXX SVXY`),
  // ---- 目标风险型：股债混合 ----
  ...group(MIX_80_20, `AOA`),
  ...group(MIX_60_40, `AOR BAL`),
  ...group(MIX_40_60, `AOM`),
  ...group(MIX_30_70, `AOK`),
  // ---- 可转债 / 优先股 ----
  ...group(BOND, `ICVT CWB FCVT PFF PFFD`),
]

/** 代码 → 占比（小写键，便于忽略大小写查询） */
export const ETF_PRESETS: Record<string, AssetMix> = Object.fromEntries(
  ENTRIES.map(([code, t]) => [code.toLowerCase(), mix(t)]),
)

/** 长久期债券：覆盖「默认中期」，落进长期国债桶 */
export const LONG_BOND_CODES = new Set(
  `TLT EDV ZROZ SPTL BLV VCLT SCHQ`.split(/\s+/).map((c) => c.toLowerCase()),
)

/**
 * 港股上市 ETF（东财同样拿不到数据）。
 * 盈富基金、恒生系列这些基本都是股票型；债券/黄金类的港股 ETF 极少见，可手动设。
 */
const HK_ENTRIES: Array<[string, MixTuple]> = [
  ...group(EQ, `02800 02828 02822 03033 03032 03067 03110 02823 02840 03188 03070 09010 02837 03069`),
  ...group(BOND, `03077 09177 02829`),
  ...group(GOLD, `03081 09081`),
]
const HK_PRESETS: Record<string, AssetMix> = Object.fromEntries(
  HK_ENTRIES.map(([code, t]) => [code, mix(t)]),
)

export interface EtfPreset {
  mix: AssetMix
  bondTerm?: 'long' | 'mid'
}

/** 查内置预设：命中返回占比（长久期债券会带 bondTerm） */
export function presetOf(code: string | undefined, market: string | undefined): EtfPreset | undefined {
  const c = (code ?? '').trim().toLowerCase()
  if (!c) return undefined
  if (market === 'us') {
    const hit = ETF_PRESETS[c]
    if (hit) return { mix: hit, bondTerm: LONG_BOND_CODES.has(c) ? 'long' : undefined }
    return undefined
  }
  if (market === 'hk') {
    // 港股代码统一成 5 位（0700 → 00700）
    const padded = c.replace(/\D/g, '').padStart(5, '0')
    const hit = HK_PRESETS[padded]
    if (hit) return { mix: hit }
  }
  return undefined
}

/** 供界面显示覆盖率/调试用 */
export const ETF_PRESET_COUNT = Object.keys(ETF_PRESETS).length + Object.keys(HK_PRESETS).length
