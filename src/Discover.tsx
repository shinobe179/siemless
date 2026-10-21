import { useEffect, useMemo, useRef, useState } from 'react'
import { query, type Field } from './db'
import { EChart, useTheme } from './EChart'
import {
  appendWhere,
  autoInterval,
  buildWhere,
  filterClause,
  flatten,
  fmtTime,
  getPath,
  show,
  toInput,
  type Filters,
} from './util'

type Props = {
  fields: Field[]
  filters: Filters
  /** 検索バーへ条件を追加する */
  addClause: (clause: string) => void
  setRange: (from: string, to: string) => void
  /** 実行ボタン押下ごとに増える。条件が同じでも再取得させる */
  tick: number
}

type Doc = { t: number; j: any }
const PAGE = 100

export function Discover({ fields, filters, addClause, setRange, tick }: Props) {
  const theme = useTheme()
  const where = useMemo(() => buildWhere(filters), [filters, tick])
  const [stats, setStats] = useState<{ n: number; min: number; max: number } | null>(null)
  const [hist, setHist] = useState<{ t: number; c: number }[]>([])
  const [interval, setIntervalStr] = useState('1 hour')
  const [docs, setDocs] = useState<Doc[]>([])
  const [limit, setLimit] = useState(PAGE)
  const [error, setError] = useState('')
  const [cols, setCols] = useState<string[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [fieldQ, setFieldQ] = useState('')
  const seq = useRef(0)

  useEffect(() => setLimit(PAGE), [where])

  useEffect(() => {
    const id = ++seq.current
    ;(async () => {
      try {
        const [s] = await query(
          `SELECT count(*)::DOUBLE AS n, epoch_ms(min(ts))::DOUBLE AS mn, epoch_ms(max(ts))::DOUBLE AS mx FROM logs WHERE ${where}`,
        )
        if (id !== seq.current) return
        const st = { n: s.n, min: s.mn ?? 0, max: s.mx ?? 0 }
        const iv = autoInterval(st.max - st.min)
        const h = await query(
          `SELECT epoch_ms(time_bucket(INTERVAL '${iv}', ts))::DOUBLE AS t, count(*)::DOUBLE AS c FROM logs WHERE ${where} GROUP BY 1 ORDER BY 1`,
        )
        const d = await query(
          `SELECT epoch_ms(ts)::DOUBLE AS t, to_json(logs) AS j FROM logs WHERE ${where} ORDER BY ts DESC LIMIT ${limit}`,
        )
        if (id !== seq.current) return
        setStats(st)
        setIntervalStr(iv)
        setHist(h as any)
        setDocs(d.map((r) => ({ t: r.t, j: JSON.parse(r.j) })))
        setError('')
      } catch (e: any) {
        if (id === seq.current) setError(String(e.message ?? e))
      }
    })()
  }, [where, limit])

  const histOption = useMemo(
    () => ({
      animation: false,
      grid: { left: 44, right: 12, top: 12, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (p: any) => `${fmtTime(p[0].value[0], false)} UTC<br/><b>${p[0].value[1].toLocaleString()}</b> 件`,
      },
      brush: { toolbox: [], xAxisIndex: 0, brushType: 'lineX', brushMode: 'single', transformable: false },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: theme.grid } },
        axisLabel: { color: theme.muted },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: theme.muted },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      series: [
        {
          type: 'bar',
          data: hist.map((h) => [h.t, h.c]),
          itemStyle: { color: theme.series[0], borderRadius: [3, 3, 0, 0] },
          barCategoryGap: '15%',
        },
      ],
    }),
    [hist, theme],
  )

  const onBrush = useMemo(
    () => (a: number, b: number) => setRange(toInput(a), toInput(b + 60_000)),
    [setRange],
  )

  const shownFields = fields.filter((f) => f.name.toLowerCase().includes(fieldQ.toLowerCase()))
  const toggleCol = (n: string) => setCols((c) => (c.includes(n) ? c.filter((x) => x !== n) : [...c, n]))

  return (
    <div className="discover">
      <aside className="fields">
        <input
          className="field-search"
          placeholder="フィールドを検索"
          value={fieldQ}
          onChange={(e) => setFieldQ(e.target.value)}
        />
        {cols.length > 0 && (
          <>
            <h4>選択中</h4>
            {cols.map((c) => (
              <div key={c} className="field-row sel">
                <span className="fname">{c}</span>
                <button title="列から外す" onClick={() => toggleCol(c)}>
                  −
                </button>
              </div>
            ))}
          </>
        )}
        <h4>
          フィールド <span className="muted">{shownFields.length}</span>
        </h4>
        {shownFields.map((f) => (
          <FieldItem
            key={f.name}
            f={f}
            where={where}
            total={stats?.n ?? 0}
            selected={cols.includes(f.name)}
            toggle={() => toggleCol(f.name)}
            addClause={addClause}
          />
        ))}
      </aside>

      <section className="results">
        <div className="hits">
          <b>{stats ? stats.n.toLocaleString() : '…'}</b> hits
          <span className="muted">
            {stats && stats.n > 0 && ` · ${fmtTime(stats.min, false)} – ${fmtTime(stats.max, false)} UTC · 間隔 ${interval}`}
          </span>
          <span className="muted hint">ヒストグラムをドラッグで時間範囲を絞り込み</span>
        </div>
        {error && <div className="error">{error}</div>}
        <EChart option={histOption} height={170} onBrush={onBrush} />

        <div className="table-wrap">
          <table className="docs">
            <thead>
              <tr>
                <th style={{ width: 24 }} />
                <th style={{ width: 150 }}>ts (UTC)</th>
                {cols.length === 0 ? <th>_source</th> : cols.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {docs.map((d, i) => (
                <DocRow
                  key={i}
                  doc={d}
                  cols={cols}
                  open={open === i}
                  toggle={() => setOpen(open === i ? null : i)}
                  addClause={addClause}
                  toggleCol={toggleCol}
                  colSpan={2 + Math.max(1, cols.length)}
                />
              ))}
            </tbody>
          </table>
          {stats && stats.n > docs.length && (
            <button className="more" onClick={() => setLimit((l) => Math.min(l + PAGE, 1000))} disabled={limit >= 1000}>
              {limit >= 1000 ? '表示上限 (1000件) です。条件を絞り込んでください' : `さらに ${PAGE} 件読み込む`}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function FieldItem(p: {
  f: Field
  where: string
  total: number
  selected: boolean
  toggle: () => void
  addClause: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [vals, setVals] = useState<{ v: string | null; c: number }[] | null>(null)

  useEffect(() => {
    if (!open || p.f.list) return
    let live = true
    setVals(null)
    query(
      `SELECT CAST(${p.f.ref} AS VARCHAR) AS v, count(*)::DOUBLE AS c FROM logs WHERE ${p.where} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 5`,
    )
      .then((r) => live && setVals(r as any))
      .catch(() => live && setVals([]))
    return () => {
      live = false
    }
  }, [open, p.where, p.f.ref])

  return (
    <div className="field-item">
      <div className="field-row" onClick={() => setOpen(!open)}>
        <span className="ftype" title={p.f.type}>
          {typeBadge(p.f)}
        </span>
        <span className="fname" title={p.f.name}>
          {p.f.name}
        </span>
        <button
          title={p.selected ? '列から外す' : '列に追加'}
          onClick={(e) => {
            e.stopPropagation()
            p.toggle()
          }}
        >
          {p.selected ? '−' : '+'}
        </button>
      </div>
      {open && (
        <div className="topvals">
          {p.f.list ? (
            <div className="muted">配列型のため集計できません</div>
          ) : vals === null ? (
            <div className="muted">集計中…</div>
          ) : (
            vals.map((x, i) => (
              <div className="tv" key={i}>
                <div className="tvhead">
                  <span className="tvval" title={x.v ?? ''}>
                    {x.v ?? '(null)'}
                  </span>
                  <span className="muted">{p.total ? Math.round((x.c / p.total) * 1000) / 10 : 0}%</span>
                  <button title="この値で絞り込む" onClick={() => p.addClause(filterClause(p.f.ref, x.v, false))}>
                    ＋
                  </button>
                  <button title="この値を除外" onClick={() => p.addClause(filterClause(p.f.ref, x.v, true))}>
                    −
                  </button>
                </div>
                <div className="bar">
                  <i style={{ width: `${p.total ? (x.c / p.total) * 100 : 0}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// _source の要約表示では、時刻の重複や定型値を省き、判断に使う列を先頭に出す
const NOISY = new Set(['ts', 'timestamp', 'formatVersion', 'webaclId', 'httpRequest.requestId'])
const PRIORITY = ['action', 'terminatingRuleId', 'httpRequest.clientIp', 'httpRequest.country', 'httpRequest.httpMethod', 'httpRequest.uri', 'httpRequest.args']
const rank = (n: string) => {
  const i = PRIORITY.indexOf(n)
  return i < 0 ? PRIORITY.length : i
}

function typeBadge(f: Field) {
  if (f.list) return '[ ]'
  if (/Timestamp|Date/.test(f.type)) return '⏱'
  if (/Int|Float|Decimal/.test(f.type)) return '#'
  if (/Bool/.test(f.type)) return '?'
  return 't'
}

function DocRow(p: {
  doc: Doc
  cols: string[]
  open: boolean
  toggle: () => void
  addClause: (c: string) => void
  toggleCol: (n: string) => void
  colSpan: number
}) {
  const flat = useMemo(() => (p.open ? flatten(p.doc.j) : []), [p.open, p.doc])
  const summary = useMemo(
    () =>
      p.cols.length
        ? []
        : flatten(p.doc.j)
            .filter((x) => !NOISY.has(x.name) && x.value !== null && !(Array.isArray(x.value) && x.value.length === 0))
            .sort((a, b) => rank(a.name) - rank(b.name))
            .map((x) => [x.name, show(x.value)]),
    [p.cols.length, p.doc],
  )
  return (
    <>
      <tr className="doc" onClick={p.toggle}>
        <td className="caret">{p.open ? '▾' : '▸'}</td>
        <td className="mono nowrap">{fmtTime(p.doc.t)}</td>
        {p.cols.length === 0 ? (
          <td className="src">
            {summary.map(([k, v]) => (
              <span key={k}>
                <em>{k}:</em> {v}{' '}
              </span>
            ))}
          </td>
        ) : (
          p.cols.map((c) => (
            <td key={c} className="mono">
              {show(getPath(p.doc.j, c))}
            </td>
          ))
        )}
      </tr>
      {p.open && (
        <tr className="detail">
          <td colSpan={p.colSpan}>
            <table className="kv">
              <tbody>
                {flat.map((x) => (
                  <tr key={x.name}>
                    <td className="k">{x.name}</td>
                    <td className="act">
                      {!x.list && (
                        <>
                          <button title="絞り込む" onClick={() => p.addClause(filterClause(x.ref, x.value, false))}>
                            ＋
                          </button>
                          <button title="除外" onClick={() => p.addClause(filterClause(x.ref, x.value, true))}>
                            −
                          </button>
                        </>
                      )}
                      <button title="列に追加/削除" onClick={() => p.toggleCol(x.name)}>
                        ▥
                      </button>
                    </td>
                    <td className="mono v">{show(x.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}
