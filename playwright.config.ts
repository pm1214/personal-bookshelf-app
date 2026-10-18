import { defineConfig, devices } from '@playwright/test';

// デモ（demo/dist/bookshelf_hub.standalone.html）の画面テスト。
// 初回は `npx playwright install chromium` が必要。
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  reporter: [['list']],
  use: { browserName: 'chromium' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1200, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    // iPhone（Safari の WebKit）。`npx playwright install webkit` のあと PW_WEBKIT=1 で実行する
    ...(process.env.PW_WEBKIT ? [{ name: 'iphone', use: { ...devices['iPhone 14'] } }] : []),
  ],
});
