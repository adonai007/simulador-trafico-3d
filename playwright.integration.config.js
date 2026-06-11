// TEMPORARY integration-run config: identical to playwright.config.js but on
// port 5174 — port 5173 is occupied by an unrelated project's dev server
// (81_DIARIOMED_v3) on this machine, so reuseExistingServer would hit the
// wrong app. Safe to delete after the integration pass.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5174',
    headless: true,
  },
  webServer: {
    command: 'npx vite dev --port 5174',
    port: 5174,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
