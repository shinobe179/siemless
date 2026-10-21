export type Filters = { where: string; from: string; to: string }

const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/

/** 検索バーと時間範囲から WHERE 句本体を組み立てる (時刻は UTC) */
export function buildWhere({ where, from, to }: Filters): string {
  const c: string[] = []
  if (where.trim()) c.push(`(${where.trim()})`)
  if (TS_RE.test(from)) c.push(`ts >= TIMESTAMP '${from.replace('T', ' ')}'`)
  if (TS_RE.test(to)) c.push(`ts < TIMESTAMP '${to.replace('T', ' ')}'`)
  return c.length ? c.join(' AND ') : 'TRUE'
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** ms → 'YYYY-MM-DD HH:mm:ss' (UTC) */
export function fmtTime(ms: number, withSec = true): string {
  const d = new Date(ms)
  const s = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  return withSec ? `${s}:${p2(d.getUTCSeconds())}` : s
}

export const toInput = (ms: number) => fmtTime(ms, false).replace(' ', 'T')

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

export function filterClause(ref: string, v: unknown, negate: boolean): string {
  if (v === null || v === undefined) return `${ref} IS ${negate ? 'NOT ' : ''}NULL`
  return `${ref} ${negate ? '<>' : '='} ${sqlLiteral(v)}`
}

export const appendWhere = (cur: string, clause: string) => (cur.trim() ? `${cur.trim()} AND ${clause}` : clause)

export type Flat = { name: string; ref: string; value: unknown; list: boolean }

const qs = (s: string) => `"${s.replace(/"/g, '""')}"`

/** ドキュメントを (パス, 値) の組へ平坦化する。配列はそのまま 1 つの値として扱う */
export function flatten(obj: any, path: string[] = [], out: Flat[] = []): Flat[] {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = [...path, k]
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out)
    else out.push({ name: p.join('.'), ref: p.map(qs).join('.'), value: v, list: Array.isArray(v) })
  }
  return out
}

export function getPath(obj: any, name: string): unknown {
  let cur = obj
  for (const k of name.split('.')) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

export function show(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const INTERVALS: [number, string][] = [
  [60e3, '1 minute'],
  [300e3, '5 minutes'],
  [600e3, '10 minutes'],
  [1800e3, '30 minutes'],
  [3600e3, '1 hour'],
  [10800e3, '3 hours'],
  [43200e3, '12 hours'],
  [86400e3, '1 day'],
]
export const INTERVAL_OPTIONS = INTERVALS.map(([, s]) => s)

/** 範囲が約 80 バケット以内に収まる最小の間隔を選ぶ */
export function autoInterval(spanMs: number): string {
  return (INTERVALS.find(([ms]) => spanMs / ms <= 80) ?? INTERVALS[INTERVALS.length - 1])[1]
}
