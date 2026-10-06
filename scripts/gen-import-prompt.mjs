// 从 src/lib/holdingImport.ts 的 HOLDING_IMPORT_PROMPT 生成 docs/持仓导入提示词.md
// 用法：node scripts/gen-import-prompt.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const BT = String.fromCharCode(96)
const FENCE = BT + BT + BT
const code = (s) => BT + s + BT

const MARK = 'export const HOLDING_IMPORT_PROMPT = ' + BT
const src = readFileSync('src/lib/holdingImport.ts', 'utf8')
const start = src.indexOf(MARK)
if (start < 0) {
  console.error('没找到 HOLDING_IMPORT_PROMPT')
  process.exit(1)
}
const body = src.slice(start + MARK.length)
const prompt = body.slice(0, body.indexOf(BT)).trim()

const doc = [
  '# 持仓导入提示词（v1）',
  '',
  '> 本文件由 ' + code('scripts/gen-import-prompt.mjs') + ' 从 ' + code('src/lib/holdingImport.ts') +
    ' 的 ' + code('HOLDING_IMPORT_PROMPT') + ' 生成。改提示词请改代码那一处，再运行 ' +
    code('node scripts/gen-import-prompt.mjs') + '。',
  '',
  '## 怎么用',
  '',
  '1. 打开 WealthCard → **基金**（或**股票**）分类 →「批量导入（粘贴 AI 识别的文字）」',
  '2. 点「**复制提示词**」',
  '3. 连同**持仓截图**发给能看图的 AI',
  '4. 把 AI 输出的文字粘回弹窗 →「**解析**」→ 核对预览（可勾选、可就地改）→「**导入选中的 N 条**」',
  '',
  '截图里必须能看到：**名称或代码 + 持有份额 + 成本（单价或总额）**。缺了的话，AI 会写 ' +
    code('# 缺少：…') + ' 告诉你缺什么。',
  '',
  '## 提示词全文（可直接复制）',
  '',
  FENCE + 'text',
  prompt,
  FENCE,
  '',
  '## 字段说明',
  '',
  '| 字段 | 必填 | 说明 |',
  '| --- | --- | --- |',
  '| ' + code('类型') + ' | ✅ | ' + code('基金') + '（场外）/ ' + code('股票') + '（A股·港股·美股） |',
  '| ' + code('市场') + ' | 股票必填 | ' + code('A股') + ' / ' + code('港股') + ' / ' + code('美股') + '；基金可省略 |',
  '| ' + code('代码') + ' | ✅ | 基金与 A股 6 位、港股 1~5 位、美股字母 |',
  '| ' + code('名称') + ' | 可选 | App 会按代码查行情比对，不一致时提示 |',
  '| ' + code('份额') + ' | ✅ | 份数/股数（**不是金额**） |',
  '| ' + code('成本单价') + ' 或 ' + code('成本总额') + ' | 至少一个 | 总额会按份额自动换算成单价 |',
  '| ' + code('币种') + ' | 可选 | 默认：港股 HKD / 美股 USD / 其余 CNY |',
  '| ' + code('现价') + ' | 可选 | 行情拉不到时的兜底 |',
  '| ' + code('备注') + ' | 可选 | 账户名等 |',
  '',
  '## 解析器容错的写法',
  '',
  '- 全角 ' + code('＝') + ' ' + code('：') + ' ' + code('；') + '、中英文键名混用（' + code('code=') +
    ' / ' + code('代码=') + '）、字段顺序随意、大小写不敏感',
  '- 金额可带千分位与货币符号：' + code('1,234.56') + '、' + code('¥1234.56') + '、' + code('$520') + '、' + code('1.2万'),
  '- 单位「手」自动按 **1 手 = 100 股** 换算，并提示你核对（券商截图很容易差 100 倍）',
  '- 也支持 **Markdown 表格**（表头当键名）',
  '- ' + code('#') + ' 开头的行是注释：导入时忽略，但会显示在弹窗「AI 的说明」里',
  '',
  '## 常见错误与处理',
  '',
  '| 情况 | 结果 |',
  '| --- | --- |',
  '| 缺代码 / 缺份额 / 份额 ≤ 0 / 成本不是数字 | ❌ 该行不导入，列出原因 |',
  '| 代码与市场不匹配（A股 6 位、港股 1~5 位、美股字母） | ❌ 该行不导入 |',
  '| 市场写成无法识别的词 | ❌ 该行不导入 |',
  '| 没写成本 | ⚠️ 允许导入，提示「浮盈会失真」 |',
  '| 同时给了单价与总额且对不上 | ⚠️ 按单价处理并提示 |',
  '| 币种与市场冲突 | ⚠️ 按市场处理并提示 |',
  '| 同代码已存在 | 默认不勾选；可勾「已存在的也导入」 |',
  '| 整段是 Markdown 表格 | ✅ 自动识别 |',
  '',
  '## 隐私提醒',
  '',
  '截图包含你的完整持仓明细。把它交给哪一家 AI，等于把这些数据给了那家 —— 请自行判断。',
  '',
].join(String.fromCharCode(10))

mkdirSync('docs', { recursive: true })
writeFileSync('docs/持仓导入提示词.md', doc)
console.log('已生成 docs/持仓导入提示词.md（' + doc.length + ' 字符）')
