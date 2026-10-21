import { useEffect, useRef, useState } from 'react'
import * as echarts from 'echarts'

/** CSS トークンからチャート用の配色を読む (ライト/ダークは CSS 側で切り替わる) */
export function useTheme() {
  const read = () => {
    const s = getComputedStyle(document.documentElement)
    const v = (n: string) => s.getPropertyValue(n).trim()
    return {
      series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
      text: v('--text-primary'),
      text2: v('--text-secondary'),
      muted: v('--text-muted'),
      grid: v('--grid'),
      surface: v('--surface-1'),
    }
  }
  const [t, setT] = useState(read)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const h = () => setT(read())
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return t
}

type Props = {
  option: echarts.EChartsCoreOption
  height?: number
  /** 時間軸ヒストグラムのドラッグ選択 (ミリ秒) */
  onBrush?: (from: number, to: number) => void
}

export function EChart({ option, height = 220, onBrush }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const brushCb = useRef(onBrush)
  brushCb.current = onBrush

  useEffect(() => {
    const c = echarts.init(el.current!, undefined)
    chart.current = c
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(el.current!)
    c.on('brushEnd', (p: any) => {
      const r = p.areas?.[0]?.coordRange
      if (r && brushCb.current) brushCb.current(Math.floor(r[0]), Math.ceil(r[1]))
      c.dispatchAction({ type: 'brush', areas: [] })
    })
    return () => {
      ro.disconnect()
      c.dispose()
    }
  }, [])

  useEffect(() => {
    const c = chart.current!
    c.setOption({ useUTC: true, ...option }, true)
    if (onBrush) c.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } })
  }, [option, onBrush])

  return <div ref={el} style={{ height, width: '100%' }} role="img" aria-label="chart" />
}
