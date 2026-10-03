import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import type { SalaryRecord } from '../lib/settings'
import { formatCNY } from '../lib/format'

/**
 * 薪资走势：按月柱状图。
 * 只展示最近的月份，避免记录多了以后横轴挤在一起。
 */
export default function SalaryChart({ records, maxBars = 12 }: { records: SalaryRecord[]; maxBars?: number }) {
  const shown = records.slice(-maxBars)
  const data = shown.map((r) => ({
    month: r.month.slice(2), // 24-10，省空间
    amount: r.amount,
    applied: r.applied === true,
  }))
  const max = Math.max(...data.map((d) => d.amount), 1)

  return (
    <div style={{ height: 150 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 8 }}>
          <XAxis
            dataKey="month"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--chart-tick)', fontSize: 10 }}
          />
          <YAxis hide domain={[0, max * 1.2]} />
          <Bar dataKey="amount" radius={[4, 4, 0, 0]} barSize={data.length > 8 ? 12 : 18} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.applied ? 'var(--accent-green)' : 'var(--chart-tick)'} />
            ))}
            <LabelList
              dataKey="amount"
              position="top"
              formatter={(v: number) => formatCNY(v, 0)}
              style={{ fill: 'var(--ink3)', fontSize: 9 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
