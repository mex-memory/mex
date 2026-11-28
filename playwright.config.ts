import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/hub-e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 2,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
