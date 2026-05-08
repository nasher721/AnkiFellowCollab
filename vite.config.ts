/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devServerPort = Number(process.env.E2E_PORT || 5174);

export default defineConfig({
  plugins: [react()],
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
