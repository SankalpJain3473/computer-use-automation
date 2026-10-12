import type { Page } from "playwright";

export const BASE_URL = process.env.TARGET_APP_URL ?? "http://localhost:4173";

// Login is connection setup, never a recorded step, so credentials stay out of artifacts.
export async function bootstrapSession(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { timeout: 15000 });
  await page.fill('input[name="username"]', "teller1");
  await page.fill('input[name="password"]', "demo");
  await page.click('input[type="submit"]');
  await page.waitForLoadState("load", { timeout: 15000 });
}
