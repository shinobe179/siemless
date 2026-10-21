import * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export type Field = {
  /** ドット区切りの表示名 (例: httpRequest.clientIp) */
  name: string
  /** SQL で参照するための引用済み式 */
  ref: string
  type: string
  /** リスト型は集計・フィルタ対象外 */
  list: boolean
}

export type Source = { kind: 'file'; file: File } | { kind: 'url'; url: string } | { kind: 'sample' }

type Ctx = { db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection; persisted: boolean }

const DB_PATH = 'opfs://siemless.db'
let ctxP: Promise<Ctx> | null = null

export const getDb = () => (ctxP ??= init())

async function init(): Promise<Ctx> {
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  })
  const open = async (path?: string) => {
    const worker = new Worker(bundle.mainWorker!)
    const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    if (path) await db.open({ path, accessMode: duckdb.DuckDBAccessMode.READ_WRITE })
    return db
  }
  let db: duckdb.AsyncDuckDB
  let persisted = true
  try {
    db = await open(DB_PATH)
  } catch (e) {
    // OPFS が使えない環境ではメモリ DB で動かす
    console.warn('OPFS unavailable, falling back to in-memory DB', e)
    persisted = false
    db = await open()
  }
  const conn = await db.connect()
  return { db, conn, persisted }
}

const plain = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)

export type QueryResult = { rows: Record<string, any>[]; fields: { name: string; type: string }[] }

export async function queryFull(sql: string): Promise<QueryResult> {
  const { conn } = await getDb()
  const res = await conn.query(sql)
  const fields = res.schema.fields.map((f) => ({ name: f.name, type: String(f.type) }))
  const rows = res.toArray().map((r) => {
    const o = r.toJSON()
    for (const k of Object.keys(o)) o[k] = plain(o[k])
    return o
  })
  return { rows, fields }
}

export const query = async (sql: string) => (await queryFull(sql)).rows

export async function isPersisted() {
  return (await getDb()).persisted
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`

/** logs テーブルのスキーマを Arrow 型から再帰的に展開してリーフ列の一覧にする */
export async function loadFields(): Promise<Field[]> {
  const { conn } = await getDb()
  const res = await conn.query('SELECT * FROM logs LIMIT 0')
  const out: Field[] = []
  const walk = (type: any, path: string[]) => {
    // Arrow の Type.Struct_ = 13
    if (type.typeId === 13) {
      for (const c of type.children) walk(c.type, [...path, c.name])
    } else {
      out.push({
        name: path.join('.'),
        ref: path.map(q).join('.'),
        type: String(type),
        list: type.typeId === 12,
      })
    }
  }
  for (const f of res.schema.fields) walk(f.type, [f.name])
  return out
}

export async function tableExists() {
  const { conn } = await getDb()
  const r = await conn.query(`SELECT count(*)::INTEGER AS n FROM information_schema.tables WHERE table_name = 'logs'`)
  return Number(r.toArray()[0].n) > 0
}

const TIME_NAMES = ['timestamp', '@timestamp', 'time', 'ts', 'eventtime', 'event_time', 'datetime', 'date']

function timeExpr(cols: { column_name: string; column_type: string }[]) {
  const ranked = [...cols].sort((a, b) => {
    const ra = TIME_NAMES.indexOf(a.column_name.toLowerCase())
    const rb = TIME_NAMES.indexOf(b.column_name.toLowerCase())
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb)
  })
  for (const c of ranked) {
    const col = q(c.column_name)
    const t = c.column_type
    if (/^TIMESTAMP/.test(t)) return `${col}::TIMESTAMP`
    const named = TIME_NAMES.includes(c.column_name.toLowerCase())
    if (/^(BIGINT|INTEGER|HUGEINT|UBIGINT|DOUBLE)$/.test(t) && named)
      // 1e11 より大きければミリ秒、小さければ秒とみなす
      return `epoch_ms(CASE WHEN ${col} > 1e11 THEN ${col}::BIGINT ELSE (${col} * 1000)::BIGINT END)`
    if (t === 'VARCHAR' && named) return `TRY_CAST(${col} AS TIMESTAMP)`
  }
  throw new Error('時刻列 (timestamp / time 等) が見つかりませんでした')
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`

export async function ingest(src: Source, mode: 'replace' | 'append'): Promise<number> {
  const { db, conn } = await getDb()
  let name: string
  if (src.kind === 'file') {
    name = `upload/${src.file.name}`
    await db.registerFileHandle(name, src.file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true)
  } else if (src.kind === 'sample') {
    const r = await fetch(`${import.meta.env.BASE_URL}sample/waf-sample.ndjson.gz`)
    if (!r.ok) throw new Error(`サンプルの取得に失敗: ${r.status}`)
    const buf = new Uint8Array(await r.arrayBuffer())
    // サーバが Content-Encoding: gzip を付けるとブラウザが展開済みで返すため、実体で判定する
    const gz = buf[0] === 0x1f && buf[1] === 0x8b
    name = gz ? 'sample/waf-sample.ndjson.gz' : 'sample/waf-sample.ndjson'
    await db.registerFileBuffer(name, buf)
  } else {
    name = src.url
  }
  const ext = name.replace(/[?#].*$/, '').replace(/\.gz$/i, '').split('.').pop()!.toLowerCase()
  const from =
    ext === 'parquet'
      ? `read_parquet(${lit(name)})`
      : ext === 'csv'
        ? `read_csv_auto(${lit(name)})`
        : `read_json_auto(${lit(name)}, format='auto', sample_size=100000, union_by_name=true)`

  const cols = (await conn.query(`DESCRIBE SELECT * FROM ${from}`)).toArray().map((r) => r.toJSON()) as any[]
  const tsx = timeExpr(cols)
  const hasTs = cols.some((c) => c.column_name === 'ts')
  const select = `SELECT ${tsx} AS ts, * ${hasTs ? 'EXCLUDE (ts)' : ''} FROM ${from}`

  if (mode === 'append' && (await tableExists())) {
    await conn.query(`INSERT INTO logs BY NAME ${select}`)
  } else {
    await conn.query(`CREATE OR REPLACE TABLE logs AS ${select}`)
  }
  await conn.query('CHECKPOINT')
  await db.flushFiles()
  return Number((await conn.query('SELECT count(*)::INTEGER AS n FROM logs')).toArray()[0].n)
}

export async function dropLogs() {
  const { db, conn } = await getDb()
  await conn.query('DROP TABLE IF EXISTS logs')
  await conn.query('CHECKPOINT')
  await db.flushFiles()
}
