/* global process */
import { defineConfig, devices } from '@playwright/test'

const npmCommand = process.platform === 'win32' ? 'npm.cmd run preview' : 'npm run preview'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5182',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-iphone-viewport', use: { ...devices['iPhone 13'] } },
    { name: 'webkit-ipad-viewport', use: { ...devices['iPad (gen 7)'] } },
  ],
  webServer: {
    command: `${npmCommand} -- --host 127.0.0.1 --port 5182 --strictPort`,
    url: 'http://127.0.0.1:5182',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
