import { useCallback, useEffect, useRef, useState } from 'react'
import { dropLogs, ingest, isPersisted, loadFields, query, tableExists, type Field, type Source } from './db'
import { Discover } from './Discover'
import { Visualize } from './Visualize'
import { appendWhere, fmtTime, toInput, type Filters } from './util'

type Tab = 'discover' | 'visualize'

export function App() {
  const [ready, setReady] = useState(false)
  const [fields, setFields] = useState<Field[]>([])
  const [persisted, setPersisted] = useState(true)
  const [total, setTotal] = useState(0)
  const [range, setDataRange] = useState<[number, number] | null>(null)
  const [tab, setTab] = useState<Tab>('discover')
  const [showIngest, setShowIngest] = useState(false)

  const [filters, setFilters] = useState<Filters>({ where: '', from: '', to: '' })
  const [draft, setDraft] = useState('')
  const [tick, setTick] = useState(0)

  const refresh = useCallback(async () => {
    if (await tableExists()) {
      setFields(await loadFields())
      const [s] = await query(`SELECT count(*)::DOUBLE AS n, epoch_ms(min(ts))::DOUBLE AS a, epoch_ms(max(ts))::DOUBLE AS b FROM logs`)
      setTotal(s.n)
      setDataRange([s.a, s.b])
    } else {
      setFields([])
      setTotal(0)
      setDataRange(null)
      setShowIngest(true)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      setPersisted(await isPersisted())
      await refresh()
      setReady(true)
    })()
  }, [refresh])

  const run = () => {
    setFilters((f) => ({ ...f, where: draft }))
    setTick((t) => t + 1)
  }
  const addClause = useCallback((c: string) => {
    setDraft((d) => {
      const next = appendWhere(d, c)
      setFilters((f) => ({ ...f, where: next }))
      return next
    })
  }, [])
  const setRange = useCallback((from: string, to: string) => setFilters((f) => ({ ...f, from, to })), [])

  const preset = (hours: number | null) => {
    if (!range || hours === null) return setRange('', '')
    setRange(toInput(range[1] - hours * 3600e3), toInput(range[1] + 60e3))
  }

  return (
    <div className="app">
      <header>
        <div className="brand">siemless</div>
        <nav>
          <button className={tab === 'discover' ? 'on' : ''} onClick={() => setTab('discover')}>
            Discover
          </button>
          <button className={tab === 'visualize' ? 'on' : ''} onClick={() => setTab('visualize')}>
            Visualize
          </button>
        </nav>
        <div className="spacer" />
        <span className="muted small">
          {total > 0 && `${total.toLocaleString()} 件 (logs)`} · {persisted ? 'OPFSに保存' : 'メモリのみ'}
        </span>
        <button onClick={() => setShowIngest(!showIngest)}>データ取り込み</button>
      </header>

      {showIngest && (
        <Ingest
          hasData={total > 0}
          onDone={async () => {
            await refresh()
            setFilters({ where: '', from: '', to: '' })
            setDraft('')
            setTick((t) => t + 1)
            setShowIngest(false)
          }}
        />
      )}

      {fields.length > 0 && (
        <div className="filterbar">
          <input
            className="where"
            spellCheck={false}
            placeholder={`SQL の WHERE 句  例: action = 'BLOCK' AND httpRequest.country <> 'JP'`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
          <label className="time">
            From
            <input type="datetime-local" value={filters.from} onChange={(e) => setRange(e.target.value, filters.to)} />
          </label>
          <label className="time">
            To
            <input type="datetime-local" value={filters.to} onChange={(e) => setRange(filters.from, e.target.value)} />
          </label>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) preset(e.target.value === 'all' ? null : +e.target.value)
            }}
          >
            <option value="">クイック範囲</option>
            <option value="all">全期間</option>
            <option value="1">最新から1時間</option>
            <option value="6">最新から6時間</option>
            <option value="24">最新から24時間</option>
            <option value="72">最新から3日</option>
          </select>
          <button className="primary" onClick={run}>
            実行
          </button>
          <span className="muted small">UTC{range && ` · データ ${fmtTime(range[0], false)} – ${fmtTime(range[1], false)}`}</span>
        </div>
      )}

      <main>
        {!ready ? (
          <div className="empty">DuckDB を初期化中…</div>
        ) : fields.length === 0 ? (
          <div className="empty">データがありません。「データ取り込み」からログを読み込んでください。</div>
        ) : tab === 'discover' ? (
          <Discover fields={fields} filters={filters} addClause={addClause} setRange={setRange} tick={tick} />
        ) : (
          <Visualize fields={fields} filters={filters} tick={tick} />
        )}
      </main>
    </div>
  )
}

function Ingest({ hasData, onDone }: { hasData: boolean; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [url, setUrl] = useState('')
  const [append, setAppend] = useState(false)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const go = async (src: Source) => {
    setBusy(true)
    setErr('')
    setMsg('取り込み中…')
    try {
      const n = await ingest(src, append ? 'append' : 'replace')
      setMsg(`${n.toLocaleString()} 件取り込みました`)
      await onDone()
    } catch (e: any) {
      setErr(String(e.message ?? e))
      setMsg('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ingest">
      <div
        className={`drop ${drag ? 'over' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          const f = e.dataTransfer.files[0]
          if (f) go({ kind: 'file', file: f })
        }}
        onClick={() => input.current?.click()}
      >
        ファイルをドロップ、またはクリックして選択
        <div className="muted small">NDJSON / JSON / CSV / Parquet (.gz 可)。ブラウザの外には送信されません</div>
        <input
          ref={input}
          type="file"
          hidden
          accept=".json,.ndjson,.jsonl,.gz,.csv,.parquet"
          onChange={(e) => e.target.files?.[0] && go({ kind: 'file', file: e.target.files[0] })}
        />
      </div>
      <div className="ingest-side">
        <div className="row">
          <input
            placeholder="https://…/logs.parquet (CORS許可が必要)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url && go({ kind: 'url', url })}
          />
          <button disabled={busy || !url} onClick={() => go({ kind: 'url', url })}>
            URLから取得
          </button>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => go({ kind: 'sample' })}>
            サンプルAWS WAFログを読み込む
          </button>
          <label className="inline">
            <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} /> 既存データに追加
          </label>
          {hasData && (
            <button
              disabled={busy}
              onClick={async () => {
                await dropLogs()
                await onDone()
              }}
            >
              データを削除
            </button>
          )}
        </div>
        {msg && <div className="muted">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </div>
    </section>
  )
}
