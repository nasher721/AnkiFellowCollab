/// <reference types="vitest/config" />
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devServerPort = Number(process.env.E2E_PORT || 5174);

export default defineConfig({
  plugins: [
    react(),
    ...(process.env.ANALYZE === 'true'
      ? [visualizer({ filename: 'dist/stats.html', open: true, gzipSize: true, brotliSize: true })]
      : [])
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js']
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts']
  },
  server: {
    port: devServerPort,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4175',
      '/downloads': 'http://localhost:4175'
    }
  }
});
