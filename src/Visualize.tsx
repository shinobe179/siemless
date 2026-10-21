import { useEffect, useMemo, useRef, useState } from 'react'
import { queryFull, type Field, type QueryResult } from './db'
import { EChart, useTheme } from './EChart'
import { INTERVAL_OPTIONS, autoInterval, buildWhere, fmtTime, show, type Filters } from './util'

type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'table'
type Agg = 'count' | 'cardinality' | 'sum' | 'avg' | 'min' | 'max'
type XKind = 'date' | 'terms'

const CHARTS: [ChartType, string][] = [
  ['bar', '棒'],
  ['line', '折れ線'],
  ['area', 'エリア'],
  ['pie', '円'],
  ['table', 'テーブル'],
]
const AGGS: [Agg, string][] = [
  ['count', 'Count'],
  ['cardinality', 'Unique count'],
  ['sum', 'Sum'],
  ['avg', 'Average'],
  ['min', 'Min'],
  ['max', 'Max'],
]

type Spec = {
  chart: ChartType
  agg: Agg
  aggField: string
  xKind: XKind
  xField: string
  xSize: number
  interval: string // 'auto' | INTERVAL
  split: string
  splitSize: number
}

const DEFAULT: Spec = {
  chart: 'bar',
  agg: 'count',
  aggField: '',
  xKind: 'date',
  xField: '',
  xSize: 10,
  interval: 'auto',
  split: '',
  splitSize: 5,
}

const metricExpr = (s: Spec, fields: Field[]) => {
  const f = fields.find((x) => x.name === s.aggField)?.ref
  if (s.agg === 'count' || !f) return 'count(*)::DOUBLE'
  if (s.agg === 'cardinality') return `count(DISTINCT ${f})::DOUBLE`
  return `${s.agg}(TRY_CAST(${f} AS DOUBLE))`
}

const termExpr = (ref: string) => `COALESCE(CAST(${ref} AS VARCHAR), '(null)')`

function buildSql(s: Spec, fields: Field[], where: string, spanMs: number): string {
  const ref = (n: string) => fields.find((f) => f.name === n)!.ref
  const m = metricExpr(s, fields)
  const date = s.xKind === 'date' && s.chart !== 'pie'
  const iv = s.interval === 'auto' ? autoInterval(spanMs) : s.interval
  const x = date ? `time_bucket(INTERVAL '${iv}', ts)` : termExpr(ref(s.xField || fields[0].name))
  const size = s.chart === 'pie' ? Math.min(s.xSize, 8) : s.xSize
  const split = s.split && s.chart !== 'pie' && s.chart !== 'table' ? s.split : ''
  const lines = [`WITH b AS (SELECT ${x} AS x${split ? `, ${termExpr(ref(split))} AS s` : ''}, * FROM logs WHERE ${where})`]
  const conds: string[] = []
  if (split) conds.push(`s IN (SELECT s FROM b GROUP BY 1 ORDER BY ${m} DESC LIMIT ${s.splitSize})`)
  if (!date) conds.push(`x IN (SELECT x FROM b GROUP BY 1 ORDER BY ${m} DESC LIMIT ${size})`)
  lines.push(`SELECT x${split ? ', s' : ''}, ${m} AS value FROM b`)
  if (conds.length) lines.push(`WHERE ${conds.join('\n  AND ')}`)
  lines.push(`GROUP BY ${split ? '1, 2' : '1'}`, `ORDER BY ${date ? (split ? '1, 2' : '1') : split ? '1, 2' : 'value DESC'}`)
  return lines.join('\n')
}

type Props = { fields: Field[]; filters: Filters; tick: number }

export function Visualize({ fields, filters, tick }: Props) {
  const theme = useTheme()
  const [spec, setSpec] = useState<Spec>(() => ({ ...DEFAULT, xField: fields.find((f) => !f.list && f.name !== 'ts')?.name ?? '' }))
  const [custom, setCustom] = useState<string | null>(null) // null = ビルダー
  const [span, setSpan] = useState(7 * 86400e3)
  const [res, setRes] = useState<QueryResult | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const where = useMemo(() => buildWhere(filters), [filters, tick])
  const scalar = fields.filter((f) => !f.list)
  const numeric = scalar.filter((f) => /Int|Float|Decimal/.test(f.type))

  // 時間範囲の長さから自動間隔を決める
  useEffect(() => {
    queryFull(`SELECT epoch_ms(min(ts))::DOUBLE AS a, epoch_ms(max(ts))::DOUBLE AS b FROM logs WHERE ${where}`)
      .then((r) => setSpan((r.rows[0]?.b ?? 0) - (r.rows[0]?.a ?? 0)))
      .catch(() => {})
  }, [where])

  const sql = custom ?? (scalar.length ? buildSql(spec, fields, where, span) : '')

  useEffect(() => {
    if (!sql) return
    const id = ++seq.current
    queryFull(sql)
      .then((r) => id === seq.current && (setRes(r), setError('')))
      .catch((e) => id === seq.current && setError(String(e.message ?? e)))
  }, [sql])

  const set = <K extends keyof Spec>(k: K, v: Spec[K]) => setSpec((s) => ({ ...s, [k]: v }))
  const chart = custom !== null ? 'auto' : spec.chart

  return (
    <div className="viz">
      <aside className="panel">
        <h4>グラフ種別</h4>
        <div className="seg">
          {CHARTS.map(([k, label]) => (
            <button key={k} className={spec.chart === k && custom === null ? 'on' : ''} onClick={() => (setCustom(null), set('chart', k))}>
              {label}
            </button>
          ))}
        </div>

        <fieldset disabled={custom !== null}>
          <h4>メトリクス (Y軸)</h4>
          <select value={spec.agg} onChange={(e) => set('agg', e.target.value as Agg)}>
            {AGGS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {spec.agg !== 'count' && (
            <select value={spec.aggField} onChange={(e) => set('aggField', e.target.value)}>
              <option value="">フィールドを選択</option>
              {(spec.agg === 'cardinality' ? scalar : numeric).map((f) => (
                <option key={f.name}>{f.name}</option>
              ))}
            </select>
          )}

          <h4>バケット{spec.chart === 'pie' ? '' : ' (X軸)'}</h4>
          {spec.chart !== 'pie' && (
            <div className="seg">
              <button className={spec.xKind === 'date' ? 'on' : ''} onClick={() => set('xKind', 'date')}>
                Date histogram
              </button>
              <button className={spec.xKind === 'terms' ? 'on' : ''} onClick={() => set('xKind', 'terms')}>
                Terms
              </button>
            </div>
          )}
          {spec.xKind === 'date' && spec.chart !== 'pie' ? (
            <select value={spec.interval} onChange={(e) => set('interval', e.target.value)}>
              <option value="auto">自動 ({autoInterval(span)})</option>
              {INTERVAL_OPTIONS.map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          ) : (
            <>
              <select value={spec.xField} onChange={(e) => set('xField', e.target.value)}>
                {scalar.map((f) => (
                  <option key={f.name}>{f.name}</option>
                ))}
              </select>
              <label className="inline">
                上位
                <input type="number" min={1} max={spec.chart === 'pie' ? 8 : 100} value={spec.xSize} onChange={(e) => set('xSize', Math.max(1, +e.target.value || 1))} />件
              </label>
            </>
          )}

          {spec.chart !== 'pie' && spec.chart !== 'table' && (
            <>
              <h4>系列の分割 (任意)</h4>
              <select value={spec.split} onChange={(e) => set('split', e.target.value)}>
                <option value="">なし</option>
                {scalar.map((f) => (
                  <option key={f.name}>{f.name}</option>
                ))}
              </select>
              {spec.split && (
                <label className="inline">
                  上位
                  <input type="number" min={1} max={8} value={spec.splitSize} onChange={(e) => set('splitSize', Math.min(8, Math.max(1, +e.target.value || 1)))} />系列 (最大8)
                </label>
              )}
            </>
          )}
        </fieldset>

        <h4>SQL</h4>
        <textarea
          className="sql"
          spellCheck={false}
          value={sql}
          onChange={(e) => setCustom(e.target.value)}
          rows={Math.min(14, sql.split('\n').length + 1)}
        />
        <div className="muted small">
          {custom === null ? 'SQLを編集するとカスタムモードになります。' : '列の順: x, [系列], 値。xが時刻型なら時系列グラフになります。'}
          {custom !== null && (
            <button className="link" onClick={() => setCustom(null)}>
              ビルダーに戻す
            </button>
          )}
        </div>
      </aside>

      <section className="canvas">
        {error && <div className="error">{error}</div>}
        {res && <Render res={res} type={chart} spec={spec} theme={theme} />}
      </section>
    </div>
  )
}

function Render({ res, type, spec, theme }: { res: QueryResult; type: ChartType | 'auto'; spec: Spec; theme: ReturnType<typeof useTheme> }) {
  const [showTable, setShowTable] = useState(false)
  const names = res.fields.map((f) => f.name)
  const valKey = names[names.length - 1]
  const hasSplit = names.length >= 3
  const xIsTime = /Timestamp|Date/.test(res.fields[0]?.type ?? '')
  const kind: ChartType = type === 'auto' ? (xIsTime ? 'bar' : 'bar') : type

  const option = useMemo(() => buildOption(res, kind, xIsTime, hasSplit, valKey, theme), [res, kind, xIsTime, hasSplit, valKey, theme])

  if (res.rows.length === 0) return <div className="empty">該当するデータがありません</div>
  const asTable = kind === 'table' || showTable
  return (
    <>
      <div className="canvas-head">
        <span className="muted">{res.rows.length.toLocaleString()} rows</span>
        {kind !== 'table' && (
          <button className="link" onClick={() => setShowTable(!showTable)}>
            {showTable ? 'グラフ表示' : 'テーブル表示'}
          </button>
        )}
      </div>
      {asTable ? (
        <div className="table-wrap">
          <table className="docs">
            <thead>
              <tr>
                {names.map((n) => (
                  <th key={n}>{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r, i) => (
                <tr key={i}>
                  {res.fields.map((f, j) => (
                    <td key={j} className={j === names.length - 1 ? 'mono num' : 'mono'}>
                      {typeof r[f.name] === 'number' && /Timestamp/.test(f.type) ? fmtTime(r[f.name]) : j === names.length - 1 && typeof r[f.name] === 'number' ? r[f.name].toLocaleString() : show(r[f.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EChart option={option} height={420} />
      )}
    </>
  )
}

function buildOption(res: QueryResult, kind: ChartType, xIsTime: boolean, hasSplit: boolean, valKey: string, theme: ReturnType<typeof useTheme>): any {
  const [xk, sk] = [res.fields[0].name, hasSplit ? res.fields[1].name : '']
  const base = {
    animation: false,
    textStyle: { color: theme.text2 },
    tooltip: { backgroundColor: theme.surface, borderColor: theme.grid, textStyle: { color: theme.text } },
  }

  if (kind === 'pie') {
    const data = res.rows.map((r, i) => ({ name: xIsTime ? fmtTime(r[xk]) : String(r[xk]), value: r[valKey], itemStyle: { color: theme.series[i % 8] } }))
    return {
      ...base,
      tooltip: { ...base.tooltip, trigger: 'item', valueFormatter: (v: number) => v.toLocaleString() },
      legend: { bottom: 0, textStyle: { color: theme.text2 } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '72%'],
          center: ['50%', '45%'],
          data,
          itemStyle: { borderColor: theme.surface, borderWidth: 2 },
          label: { color: theme.text2, formatter: '{b}\n{d}%' },
        },
      ],
    }
  }

  // 系列ごとにまとめる。色は系列の合計の大きい順に固定スロットを割り当てる
  const groups = new Map<string, Map<any, number>>()
  for (const r of res.rows) {
    const s = sk ? String(r[sk]) : valKey
    if (!groups.has(s)) groups.set(s, new Map())
    groups.get(s)!.set(r[xk], r[valKey])
  }
  const sNames = [...groups.keys()].sort((a, b) => sum(groups.get(b)!) - sum(groups.get(a)!))
  const stacked = hasSplit && kind !== 'line'

  const xTotals = new Map<any, number>()
  for (const r of res.rows) xTotals.set(r[xk], (xTotals.get(r[xk]) ?? 0) + r[valKey])
  const cats = [...xTotals.keys()].sort((a, b) => xTotals.get(b)! - xTotals.get(a)!).map(String)

  const horizontal = !xIsTime && kind === 'bar'
  const mk = (s: string, i: number) => {
    const m = groups.get(s)!
    const color = theme.series[i % 8]
    const common: any = { name: sk ? s : valKey, color, ...(stacked ? { stack: 'total' } : {}) }
    const data = xIsTime ? [...m.entries()].map(([x, v]) => [x, v]) : cats.map((c) => [...m.entries()].find(([x]) => String(x) === c)?.[1] ?? 0)
    if (kind === 'bar')
      return {
        ...common,
        type: 'bar',
        data: xIsTime ? data : data,
        barMaxWidth: 28,
        itemStyle: { color, borderColor: theme.surface, borderWidth: stacked ? 1 : 0, borderRadius: stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
      }
    return {
      ...common,
      type: 'line',
      data,
      symbol: 'circle',
      symbolSize: 6,
      showSymbol: !xIsTime,
      lineStyle: { width: 2, color },
      itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
      ...(kind === 'area' ? { areaStyle: { opacity: 0.18 }, stack: hasSplit ? 'total' : undefined } : {}),
    }
  }

  const valAxis = { type: 'value', axisLabel: { color: theme.muted }, splitLine: { lineStyle: { color: theme.grid } } }
  const catAxis = { type: 'category', data: horizontal ? [...cats].reverse() : cats, axisLabel: { color: theme.muted, hideOverlap: true }, axisLine: { lineStyle: { color: theme.grid } }, axisTick: { show: false } }
  const timeAxis = { type: 'time', axisLabel: { color: theme.muted }, axisLine: { lineStyle: { color: theme.grid } }, splitLine: { show: false } }
  const xAxis = xIsTime ? timeAxis : horizontal ? valAxis : catAxis
  const yAxis = horizontal ? catAxis : valAxis

  const series: any[] = sNames.map(mk)
  if (horizontal) for (const s of series) s.data = [...s.data].reverse()

  return {
    ...base,
    grid: { left: horizontal ? 8 : 52, right: 20, top: hasSplit ? 40 : 16, bottom: 28, containLabel: true },
    legend: sNames.length > 1 ? { top: 0, textStyle: { color: theme.text2 } } : undefined,
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: kind === 'bar' ? 'shadow' : 'line' },
      valueFormatter: (v: number) => (typeof v === 'number' ? v.toLocaleString() : v),
      ...(xIsTime ? { formatter: timeTip } : {}),
    },
    xAxis,
    yAxis,
    series,
  }
}

function timeTip(params: any[]) {
  const t = params[0].value[0]
  const rows = params.map((p) => `${p.marker}${p.seriesName}: <b>${Number(p.value[1]).toLocaleString()}</b>`).join('<br/>')
  return `${fmtTime(t, false)} UTC<br/>${rows}`
}

const sum = (m: Map<any, number>) => [...m.values()].reduce((a, b) => a + b, 0)
