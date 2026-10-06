/**
 * 再平衡计算引擎（纯函数，无 DOM / 无 React 依赖，便于单测）
 *
 * 计算链路：
 *   用户分类市值 ──映射──> 策略资产类别金额 ──> 实际占比 / 偏离度 / 加减仓金额
 *
 * 关键约定：
 * - 映射是**条目级**优先：条目手动规则 > 条目自动识别（穿透占比/形态）> 分类级映射 > 未归类。
 *   未归类的金额不进任何桶，但要明确列给用户看（unclassifiedValue），绝不静默并进别的桶。
 * - 负债按「负的现金」计入现金桶（用户口径）；带「房」的条目、保险/年金分类、
 *   以及由「定期划扣」计划维护的负债条目都不参与配置（excludedValue）。
 * - 阈值单位是「百分点」，偏离度 0.05 就是 5 个百分点。
 */

import type { AssetItem, Category, Portfolio } from '../types/asset'
import type {
  AssetMix,
  CategoryAllocation,
  CategoryMapping,
  ClassRebalance,
  HealthLevel,
  ItemMapping,
  MappingEntry,
  RebalanceAction,
  RebalanceResult,
  SellCandidate,
  Strategy,
  StrategySettings,
} from '../types/strategy'
import { categoryTotal, effectiveFundClass, fundClassToStrategyClasses, isFund, valuate } from './calc'
import { resolveSemantic, semanticOfClass } from './assetMix'
import { isExcludedCategory, isExcludedItem, resolveItemMapping } from './itemMapping'
import type { FxRates } from './currency'
import {
  CATEGORY_KEYWORD_RULES,
  CLASS_EQUIVALENTS,
  DEFAULT_MAPPINGS,
  DEFAULT_STRATEGY_ID,
  BUILTIN_STRATEGIES,
  findBuiltinStrategy,
} from './strategies'

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export const DEFAULT_THRESHOLD = 5

export function createDefaultSettings(): StrategySettings {
  return {
    version: 1,
    activeStrategyId: DEFAULT_STRATEGY_ID,
    customStrategies: [],
    mappings: {},
    itemMappings: {},
    threshold: DEFAULT_THRESHOLD,
    includeLiabilities: false,
    unmappedPolicy: 'auto',
  }
}

/** 取当前策略（内置或自定义） */
export function resolveStrategy(settings: StrategySettings): Strategy {
  return (
    settings.customStrategies.find((s) => s.id === settings.activeStrategyId) ??
    findBuiltinStrategy(settings.activeStrategyId) ??
    BUILTIN_STRATEGIES[0]
  )
}

/** 取某策略类别的目标比例（找不到返回 -1，保证不会被选中） */
/** 该分类是否按负债处理（分类自身标记 或 名称命中负债关键词） */
export function isLiabilityCategory(category: Category): boolean {
  return category.isLiability === true
}

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

/** 内置默认映射（含自定义分类的关键词兜底） */
export function defaultMappingFor(strategy: Strategy, category: Category): MappingEntry[] {
  const builtin = DEFAULT_MAPPINGS[strategy.id]?.[category.id]
  if (builtin) return builtin.map((e) => ({ ...e }))

  const classIds = strategy.classes.map((c) => c.id)
  const keywordHit = CATEGORY_KEYWORD_RULES.find((r) => r.match.test(category.name))
  if (keywordHit) {
    const hit = keywordHit.classIds.find((id) => classIds.includes(id))
    if (hit) return [{ strategyClassId: hit, percent: 100 }]
  }
  // 关键词也认不出来 → 返回空映射，算「未归类」并明确展示给用户。
  // （以前这里会静默并进占比最大的类别，让金额"消失"在错误的桶里。）
  return []
}

/** 把映射里的类别 id 对齐到当前策略（处理策略切换后的失效 id） */
function remapToStrategy(strategy: Strategy, entries: MappingEntry[]): MappingEntry[] {
  const classIds = strategy.classes.map((c) => c.id)
  const out: MappingEntry[] = []
  for (const e of entries) {
    const percent = Number.isFinite(e.percent) ? e.percent : 0
    if (percent <= 0) continue
    if (classIds.includes(e.strategyClassId)) {
      out.push({ strategyClassId: e.strategyClassId, percent })
      continue
    }
    // 同义类别迁移（如「债券」->「长期国债」）
    const equivalents = CLASS_EQUIVALENTS[e.strategyClassId] ?? []
    const target = equivalents.find((id) => classIds.includes(id))
    if (target) out.push({ strategyClassId: target, percent })
  }
  return out
}

/**
 * 求某个分类最终生效的映射：
 * 用户设置 > 内置默认 > 关键词兜底；并保证百分比合计为 100。
 */
export function effectiveMapping(
  strategy: Strategy,
  category: Category,
  userMapping?: CategoryMapping,
): MappingEntry[] {
  const raw = remapToStrategy(strategy, userMapping?.[category.id] ?? defaultMappingFor(strategy, category))
  const usable = raw.filter((e) => strategy.classes.some((c) => c.id === e.strategyClassId) && e.percent > 0)
  if (usable.length === 0) return defaultMappingFor(strategy, category)

  const total = usable.reduce((sum, e) => sum + e.percent, 0)
  if (total <= 0) return defaultMappingFor(strategy, category)
  if (Math.abs(total - 100) < 0.01) return usable
  // 归一化，避免用户填出 80/80 这种数据把占比算错
  return usable.map((e) => ({ ...e, percent: (e.percent / total) * 100 }))
}

/* ------------------------------------------------------------------ *
 * 分配：分类金额 -> 策略类别金额
 * ------------------------------------------------------------------ */

export interface AllocationInput {
  portfolio: Portfolio
  strategy: Strategy
  /** 该策略下用户设置过的「分类级」映射 */
  mapping?: CategoryMapping
  /** 用户设置过的「条目级」映射（优先于分类级） */
  itemMapping?: ItemMapping
  /** 条目级自动识别（穿透/名称推测）的占比查询 */
  autoMixOf?: (item: AssetItem) => { mix: AssetMix; origin: 'api' | 'name' } | undefined
  /** 明确排除的条目 id（例如「定期划扣」计划维护的负债条目） */
  excludedItemIds?: string[]
  /** 负债是否计入分配（作为负的现金） */
  includeLiabilities: boolean
  /** 未映射分类的处理方式 */
  unmappedPolicy: 'auto' | 'ignore'
  /** 汇率：用于把外币条目折算成人民币后再计算占比 */
  rates?: FxRates | null
}

export interface AllocationResult {
  /** strategyClassId -> 金额 */
  byClass: Record<string, number>
  /** 分配总额（占比的分母） */
  total: number
  /** 从分母里扣掉的负债金额 */
  liabilityDeducted: number
  categories: CategoryAllocation[]
  unmappedCategories: Array<{ id: string; name: string; value: number }>
  unclassifiedItemCount: number
  /** 未归类的金额（不进任何桶，界面要明确列出来） */
  unclassifiedValue: number
  /** 被排除在配置之外的金额（房产 / 保险年金 / 分期划扣） */
  excludedValue: number
}

/**
 * 把每个分类的市值按映射拆进策略类别。
 * 基金持仓会按「资产类型」（名称识别 / 用户标记）细分到股票或债券。
 */
export function computeAllocations(input: AllocationInput): AllocationResult {
  const {
    portfolio,
    strategy,
    mapping,
    itemMapping,
    autoMixOf,
    excludedItemIds,
    includeLiabilities,
    unmappedPolicy,
    rates,
  } = input
  const byClass: Record<string, number> = {}
  for (const c of strategy.classes) byClass[c.id] = 0

  const categories: CategoryAllocation[] = []
  const unmappedCategories: Array<{ id: string; name: string; value: number }> = []
  let liabilityDeducted = 0
  let unclassifiedItemCount = 0
  let unclassifiedValue = 0
  let excludedValue = 0

  /** 语义 → 类别 id（同一语义取第一个） */
  const bySemantic = new Map<string, string>()
  for (const c of strategy.classes) {
    const s = semanticOfClass(c)
    if (s && !bySemantic.has(s)) bySemantic.set(s, c.id)
  }
  const hasSemantic = (s: string) => bySemantic.has(s)
  /**
   * 「现金」桶：负债按负值记在这里。
   * 用 resolveSemantic 走兜底 —— 60/40 没有现金桶，现金并进债券，负债就要跟着记成「负债券」。
   */
  const cashSemantic = resolveSemantic('cash', strategy, hasSemantic)
  const cashClassId = cashSemantic ? bySemantic.get(cashSemantic) : undefined

  for (const category of portfolio.categories) {
    const categoryValue = categoryTotal(category, rates)

    // 负债：取负值计入「现金」桶（用户口径）。
    // 排除项：带「房」的（房贷与自住房**成对排除**，否则配置会莫名偏空）+ 定期划扣维护的条目。
    if (isLiabilityCategory(category)) {
      let liability = 0
      for (const item of category.items) {
        const value = Math.abs(valuate(item, rates).value)
        if (value === 0) continue
        if (excludedItemIds?.includes(item.id) || isExcludedItem(item, category)) {
          excludedValue += value
          continue
        }
        liability += value
      }
      if (liability > 0 && includeLiabilities && cashClassId) {
        byClass[cashClassId] = (byClass[cashClassId] ?? 0) - liability
        liabilityDeducted += liability
      }
      continue
    }

    // 保险 / 年金 / 名称带「房」的分类：属于非投资资产，不纳入配置
    if (isExcludedCategory(category)) {
      excludedValue += Math.abs(categoryValue)
      continue
    }

    const categoryEntries = effectiveMapping(strategy, category, mapping)
    const allocation: CategoryAllocation = {
      categoryId: category.id,
      categoryName: category.name,
      categoryColor: category.color,
      value: categoryValue,
      byClass: {},
    }
    // accounted = 被处理过的条目金额（含"排除"与"未归类"）——
    // 差额兜底只能用 分类金额 − accounted，否则会把被排除的房产又按分类映射加回来
    let accountedValue = 0

    for (const item of category.items) {
      const value = valuate(item, rates).value
      if (value === 0) continue
      accountedValue += value
      const auto = autoMixOf?.(item)
      const resolved = resolveItemMapping({
        item,
        category,
        strategy,
        itemMapping,
        categoryEntries,
        autoMix: auto?.mix,
        autoMixOrigin: auto?.origin,
        excludedItemIds,
        // 债券期限做在条目上（用户口径：填国债时选长期/中期；债券基金/国债 ETF 同样适用）
        bondTerm: item.bondTerm,
      })
      if (resolved.excluded) {
        excludedValue += Math.abs(value)
        continue
      }
      if (resolved.entries.length === 0) {
        unclassifiedItemCount += 1
        unclassifiedValue += Math.abs(value)
        continue
      }
      const sum = resolved.entries.reduce((acc, e) => acc + e.percent, 0)
      if (sum <= 0) {
        unclassifiedItemCount += 1
        unclassifiedValue += Math.abs(value)
        continue
      }
      for (const entry of resolved.entries) {
        const part = (value * entry.percent) / sum
        byClass[entry.strategyClassId] = (byClass[entry.strategyClassId] ?? 0) + part
        allocation.byClass[entry.strategyClassId] = (allocation.byClass[entry.strategyClassId] ?? 0) + part
      }
      // 部分落不进去（例如策略里没有"其他"桶）：这部分明确算作未归类
      if (resolved.unclassified && resolved.unclassified > 0.0001) {
        unclassifiedValue += Math.abs(value) * resolved.unclassified
        unclassifiedItemCount += 1
      }
    }

    categories.push(allocation)
    // 分类金额与"条目金额合计"不一致时（理论上不会），差额按分类映射兜底，避免金额凭空消失
    const remainder = categoryValue - accountedValue
    if (Math.abs(remainder) > 0.005 && categoryEntries.length > 0) {
      const total = categoryEntries.reduce((acc, e) => acc + e.percent, 0)
      if (total > 0) {
        for (const entry of categoryEntries) {
          const part = (remainder * entry.percent) / total
          byClass[entry.strategyClassId] = (byClass[entry.strategyClassId] ?? 0) + part
          allocation.byClass[entry.strategyClassId] = (allocation.byClass[entry.strategyClassId] ?? 0) + part
        }
      }
    }
    if (Object.keys(allocation.byClass).length === 0 && categoryValue !== 0) {
      unmappedCategories.push({ id: category.id, name: category.name, value: categoryValue })
    }
  }

  // 分母：已归类金额 + （未归类是否计入）
  const classified = Object.values(byClass).reduce((sum, v) => sum + v, 0)
  const total = classified + (unmappedPolicy === 'auto' ? unclassifiedValue : 0)

  return {
    byClass,
    total,
    liabilityDeducted,
    categories,
    unmappedCategories,
    unclassifiedItemCount,
    unclassifiedValue,
    excludedValue,
  }
}

/* ------------------------------------------------------------------ *
 * 再平衡主函数
 * ------------------------------------------------------------------ */

export interface RebalanceOptions {
  threshold: number
  includeLiabilities: boolean
  unmappedPolicy: 'auto' | 'ignore'
  mapping?: CategoryMapping
  /** 条目级映射（优先于分类级） */
  itemMapping?: ItemMapping
  /** 条目级自动占比（穿透结果） */
  autoMixOf?: (item: AssetItem) => { mix: AssetMix; origin: 'api' | 'name' } | undefined
  /** 明确排除的条目 id（如「定期划扣」计划维护的负债条目） */
  excludedItemIds?: string[]
  /** 汇率：外币条目按此折算 */
  rates?: FxRates | null
}

/** 健康度分级：按总偏离率（Σ|偏离| / 2） */
export function healthFor(totalDeviation: number): { level: HealthLevel; label: string; hint: string } {
  if (totalDeviation <= 0.03) {
    return { level: 'healthy', label: '组合健康', hint: '各资产占比都在目标附近，无需操作' }
  }
  if (totalDeviation <= 0.08) {
    return { level: 'watch', label: '轻度偏离', hint: '略有偏离，可在下次投入时顺带校正' }
  }
  if (totalDeviation <= 0.15) {
    return { level: 'warning', label: '需要再平衡', hint: '偏离已比较明显，建议按建议金额调整' }
  }
  return { level: 'critical', label: '严重偏离', hint: '占比与策略目标差距很大，建议尽快再平衡' }
}

export const HEALTH_META: Record<HealthLevel, { label: string; badge: string; dot: string }> = {
  healthy: { label: '组合健康', badge: 'badge-good', dot: 'bg-down' },
  watch: { label: '轻度偏离', badge: 'badge-muted', dot: 'bg-good' },
  warning: { label: '需要再平衡', badge: 'badge-warn', dot: 'bg-warn' },
  critical: { label: '严重偏离', badge: 'badge-danger', dot: 'bg-danger' },
}

export function computeRebalance(
  portfolio: Portfolio,
  strategy: Strategy,
  options: RebalanceOptions,
): RebalanceResult {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD
  const allocation = computeAllocations({
    portfolio,
    strategy,
    mapping: options.mapping,
    includeLiabilities: options.includeLiabilities,
    unmappedPolicy: options.unmappedPolicy,
    rates: options.rates,
  })

  const total = allocation.total
  const sellable = collectSellableItems(portfolio, strategy, options.mapping, options.rates)

  const classes: ClassRebalance[] = strategy.classes.map((sc) => {
    const currentValue = allocation.byClass[sc.id] ?? 0
    const targetWeight = sc.target / 100
    const actualWeight = total > 0 ? currentValue / total : 0
    const deviation = actualWeight - targetWeight
    const deviationPoints = deviation * 100
    const targetValue = targetWeight * total
    const gapAmount = targetValue - currentValue
    const over = deviationPoints > threshold
    const under = deviationPoints < -threshold
    const action: RebalanceAction = over ? 'sell' : under ? 'buy' : 'hold'

    const sellCandidates =
      action === 'sell' ? buildSellCandidatesFor(sc.id, sellable) : []

    return {
      classId: sc.id,
      name: sc.name,
      color: sc.color,
      targetWeight,
      actualWeight,
      deviation,
      deviationPoints,
      targetValue,
      currentValue,
      gapAmount,
      adjustAmount: 0,
      manualAmount: 0,
      action,
      sellCandidates,
      hasUnclassified: allocation.unclassifiedItemCount > 0,
    }
  })

  // ---- 用超配类别真正能卖出的钱，去补低配类别 ----
  const sellClasses = classes.filter((c) => c.action === 'sell')
  const buyClasses = classes.filter((c) => c.action === 'buy')
  const buyNeed = buyClasses.reduce((sum, c) => sum + c.gapAmount, 0)

  /** 每个超配类别「可卖出标的的市值」（活期、房产这类卖不动的资产不计入） */
  const sellableByClass = new Map<string, number>()
  let sellableTotal = 0
  for (const c of sellClasses) {
    const sellable = c.sellCandidates.reduce((sum, cand) => sum + cand.value, 0)
    sellableByClass.set(c.classId, sellable)
    sellableTotal += sellable
  }

  /**
   * 可动用资金 = min(低配缺口总额, 所有超配类别可卖出标的的市值合计)。
   * 只用「可卖出标的」而不是「超配金额」：活期存款、房产虽然超配，但没法按比例卖掉，
   * 若计入就会出现凭空多出来的买入金额。
   *
   * 由于超配类别的实际占比之和必然等于低配类别的缺口之和，所以「卖出合计 = 买入合计」是自洽的。
   */
  const fundable = Math.min(buyNeed, sellableTotal)
  const scale = buyNeed > 0 ? fundable / buyNeed : 0

  // 买入（先补缺口最大的）
  for (const c of [...buyClasses].sort((a, b) => b.gapAmount - a.gapAmount)) {
    c.adjustAmount = c.gapAmount * scale
  }

  // 卖出：按各超配类别可卖市值的占比分摊，并封顶在自身可卖市值内
  let allocated = 0
  sellClasses.forEach((c, i) => {
    const sellable = sellableByClass.get(c.classId) ?? 0
    const raw = sellableTotal > 0 ? (sellable / sellableTotal) * fundable : 0
    const isLast = i === sellClasses.length - 1
    // 最后一个类别吃掉浮点误差，保证卖出合计与买入合计完全一致
    const amount = isLast ? Math.max(0, fundable - allocated) : Math.min(sellable, raw)
    allocated += amount
    c.adjustAmount = -amount
    // 超配但卖不动的那部分（活期、房产等），只能手动调整
    const overweight = Math.max(0, c.currentValue - c.targetValue)
    c.manualAmount = Math.max(0, overweight - amount)

    // 把卖出金额按各标的市值占比分摊到具体持仓
    const sellRatio = sellable > 0 ? Math.min(1, amount / sellable) : 0
    c.sellCandidates = c.sellCandidates.map((cand) => ({
      ...cand,
      sellAmount: cand.value * sellRatio,
      realizedProfit: cand.profit === undefined ? undefined : cand.profit * sellRatio,
    }))
  })

  const plannedSell = classes.reduce((sum, c) => sum + Math.max(0, -c.adjustAmount), 0)
  const plannedBuy = classes.reduce((sum, c) => sum + Math.max(0, c.adjustAmount), 0)

  const totalDeviation = classes.reduce((sum, c) => sum + Math.abs(c.deviation), 0) / 2
  const health = healthFor(totalDeviation)

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    totalForAllocation: total,
    liabilityDeducted: allocation.liabilityDeducted,
    threshold,
    classes,
    totalDeviation,
    totalDeviationPoints: totalDeviation * 100,
    health: health.level,
    healthLabel: health.label,
    healthHint: health.hint,
    sellCapacity: sellableTotal,
    plannedSell,
    plannedBuy,
    unmappedCategories: allocation.unmappedCategories,
    unclassifiedItemCount: allocation.unclassifiedItemCount,
    unclassifiedValue: allocation.unclassifiedValue,
    excludedValue: allocation.excludedValue,
  }
}

/* ------------------------------------------------------------------ *
 * 可卖出标的（供建议明细展示）
 * ------------------------------------------------------------------ */

interface SellableItem {
  itemId: string
  categoryId: string
  categoryName: string
  name: string
  code?: string
  value: number
  profit?: number
  /** 该标的归属的策略类别 */
  classId: string
}

/**
 * 收集可减仓的持仓（基金，因为只有基金能按份额部分卖出），
 * 并按「基金的资产类型 + 分类映射」判断它落在哪个策略类别。
 */
function collectSellableItems(
  portfolio: Portfolio,
  strategy: Strategy,
  mapping?: CategoryMapping,
  rates?: FxRates | null,
): SellableItem[] {
  const classIds = strategy.classes.map((c) => c.id)
  const out: SellableItem[] = []

  for (const category of portfolio.categories) {
    if (isLiabilityCategory(category)) continue
    const entries = effectiveMapping(strategy, category, mapping)
    // 识别不出基金类型时，退回该分类映射里占比最大的类别
    const dominantClassId = [...entries].sort((a, b) => b.percent - a.percent)[0]?.strategyClassId

    for (const item of category.items) {
      if (!isFund(item)) continue
      const v = valuate(item, rates)
      if (v.value <= 0) continue

      const fundClass = effectiveFundClass(item)
      const byType = fundClassToStrategyClasses(fundClass, classIds)[0]
      const classId = byType ?? dominantClassId ?? ''
      if (!classId) continue

      out.push({
        itemId: item.id,
        categoryId: category.id,
        categoryName: category.name,
        name: item.name || item.code,
        code: item.code,
        value: v.value,
        profit: v.profit,
        classId,
      })
    }
  }
  return out
}

/** 生成某个策略类别下的减仓候选（先卖盈利多的） */
function buildSellCandidatesFor(classId: string, sellable: SellableItem[]): SellCandidate[] {
  return sellable
    .filter((s) => s.classId === classId)
    .map((s) => ({
      itemId: s.itemId,
      categoryId: s.categoryId,
      categoryName: s.categoryName,
      name: s.name,
      code: s.code,
      value: s.value,
      sellAmount: 0,
      profit: s.profit,
    }))
    .sort((a, b) => (b.profit ?? Number.NEGATIVE_INFINITY) - (a.profit ?? Number.NEGATIVE_INFINITY))
}

/** 便捷方法：按当前设置直接算一遍 */
export interface RebalanceExtras {
  itemMapping?: ItemMapping
  autoMixOf?: (item: AssetItem) => { mix: AssetMix; origin: 'api' | 'name' } | undefined
  excludedItemIds?: string[]
}

export function rebalanceWithSettings(
  portfolio: Portfolio,
  settings: StrategySettings,
  rates?: FxRates | null,
  extras: RebalanceExtras = {},
): RebalanceResult {
  const strategy = resolveStrategy(settings)
  return computeRebalance(portfolio, strategy, {
    threshold: settings.threshold,
    includeLiabilities: settings.includeLiabilities,
    unmappedPolicy: settings.unmappedPolicy,
    mapping: settings.mappings[strategy.id],
    rates,
    ...extras,
  })
}

/** 顶部状态行文案：当前策略 · 偏离度 x.x% · 组合健康 */
export function statusLine(result: RebalanceResult): string {
  return `当前策略：${shortStrategyName(result.strategyName)} · 偏离度 ${result.totalDeviationPoints.toFixed(1)}% · ${result.healthLabel}`
}

/** 去掉策略名里的括号说明，用于小字提示 */
export function shortStrategyName(name: string): string {
  return name.replace(/（[^）]*）/g, '').trim()
}

/** 每个分类里有几条记录（供建议明细展示） */
export function countItems(category: Category | undefined): number {
  return category?.items.length ?? 0
}

/** 供 UI 判断一条记录是否可参与再平衡（目前只有基金可部分卖出） */
export function isSellableItem(item: AssetItem): boolean {
  return isFund(item)
}
