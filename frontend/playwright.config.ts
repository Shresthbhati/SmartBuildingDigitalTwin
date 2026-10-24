import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const FRONTEND = 'http://localhost:5173';
const BACKEND = 'http://localhost:8000';
// A fresh database per run so the golden loop never depends on leftover state.
const dbFile = path.join(os.tmpdir(), `nexus-e2e-${Date.now()}.db`).replace(/\\/g, '/');

export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: FRONTEND,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Set PW_CHANNEL=chrome to use an installed Chrome instead of Playwright's Chromium.
    channel: process.env.PW_CHANNEL || undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      // The simulator ingests in-process ("direct") so no MQTT broker is needed.
      command: 'python -m uvicorn app.main:app --host 127.0.0.1 --port 8000',
      cwd: '../backend',
      url: `${BACKEND}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL: `sqlite:///${dbFile}`,
        SIMULATOR_TRANSPORT: 'direct',
        PYTHONUNBUFFERED: '1',
      },
    },
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: FRONTEND,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
