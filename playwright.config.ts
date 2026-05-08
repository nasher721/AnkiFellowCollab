import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.E2E_PORT || '5174'}`;
const shouldStartWebServer = !process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: shouldStartWebServer ? {
    command: `DECKBRIDGE_DATA_DIR=$(mktemp -d /tmp/deckbridge-e2e.XXXXXX) DECKBRIDGE_REPOSITORY=local SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY= VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= E2E_PORT=${process.env.E2E_PORT || '5174'} npm run dev`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000
  } : undefined,
  use: {
    baseURL
  }
});
