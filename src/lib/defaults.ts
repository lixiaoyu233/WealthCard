import type { Category, Portfolio } from '../types/asset'

export const SCHEMA_VERSION = 2

/**
 * 默认分类（严格对齐产品需求）：
 * 现金与固定资产 / 股票 / 基金 / 黄金 / 负债
 * color 为主题色，用于图标底色与卡片强调；icon 为 lib/icons.ts 白名单键名。
 */
export function createDefaultCategories(): Category[] {
  return [
    {
      id: 'cat_cash',
      name: '现金与固定资产',
      subtitle: '银行 / 房产 / 现金',
      icon: 'banknote',
      color: '#f0b90b',
      items: [],
    },
    {
      id: 'cat_stock',
      name: '股票',
      subtitle: '全球市场 / 场内基金',
      icon: 'trending-up',
      color: '#3b82f6',
      items: [],
    },
    {
      id: 'cat_fund',
      name: '基金',
      subtitle: '场外基金 / 持仓 / 净值',
      icon: 'chart-pie',
      color: '#22c55e',
      items: [],
    },
    {
      id: 'cat_gold',
      name: '黄金',
      subtitle: '银行积存金 / 平台 / 克数',
      icon: 'gem',
      color: '#eab308',
      items: [],
    },
    {
      id: 'cat_debt',
      name: '负债',
      subtitle: '房贷 / 信用卡 / 消费贷',
      icon: 'credit-card',
      color: '#ef4444',
      isLiability: true,
      items: [],
    },
  ]
}

export function createEmptyPortfolio(): Portfolio {
  return {
    version: SCHEMA_VERSION,
    categories: createDefaultCategories(),
    history: [],
  }
}

/** 新增自定义分类时轮换使用的主题色 */
export const CATEGORY_COLORS = [
  '#f0b90b',
  '#3b82f6',
  '#22c55e',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#f97316',
  '#ec4899',
]

/** 可选的预设分类模板，方便一键添加 */
export const CATEGORY_TEMPLATES: Array<Pick<Category, 'name' | 'subtitle' | 'icon' | 'color' | 'isLiability'>> = [
  { name: '股票', subtitle: '全球市场 / 场内基金', icon: 'trending-up', color: '#3b82f6' },
  { name: '基金', subtitle: '场外基金 / 持仓 / 净值', icon: 'chart-pie', color: '#22c55e' },
  { name: '黄金', subtitle: '银行积存金 / 平台 / 克数', icon: 'gem', color: '#eab308' },
  { name: '现金与固定资产', subtitle: '银行 / 房产 / 现金', icon: 'banknote', color: '#f0b90b' },
  { name: '数字货币', subtitle: '交易所 / 冷钱包', icon: 'bitcoin', color: '#f97316' },
  { name: '保险与年金', subtitle: '储蓄险 / 年金 / 现金价值', icon: 'shield', color: '#06b6d4' },
  { name: '应收账款', subtitle: '借出款 / 待结算', icon: 'receipt', color: '#a855f7' },
  { name: '负债', subtitle: '房贷 / 信用卡 / 消费贷', icon: 'credit-card', color: '#ef4444', isLiability: true },
]
