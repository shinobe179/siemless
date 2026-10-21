import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // duckdb-wasm は事前バンドルすると worker/wasm の解決が壊れるため除外
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { port: 5173 },
})
