import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
  server: {
    proxy: {
      '/ops': 'http://localhost:8000',
      '/sessions': 'http://localhost:8000',
      '/context-graph': 'http://localhost:8000',
      '/projects': 'http://localhost:8000',
      '/jobs': 'http://localhost:8000',
      '/thinking': 'http://localhost:8000',
      '/logs': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
      '/machine-context': 'http://localhost:8000',
      '/plan': 'http://localhost:8000',
      '/execute': 'http://localhost:8000',
      '/browser': 'http://localhost:8000',
    },
  },
})
