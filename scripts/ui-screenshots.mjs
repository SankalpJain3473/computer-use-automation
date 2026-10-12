// node scripts/ui-screenshots.mjs  (needs the target app and `npm run server`). Writes evidence/ui/.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { readKeys, bearer } from "./keys.mjs";

const API = process.env.CAPABILITY_API ?? "http://localhost:4180";
const OUT = "evidence/ui";
const KEYS = readKeys();
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function signedIn(colorScheme = "light") {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
  const page = await ctx.newPage();
  await page.goto(API + "/");
  await page.waitForURL(/\/login/);
  return { ctx, page };
}

{
  const { ctx, page } = await signedIn();
  await page.fill('input[name="key"]', KEYS.agent);
  await page.click('button[type="submit"]');
  await page.waitForSelector(".err");
  await page.screenshot({ path: `${OUT}/login-agent-key-refused.png` });
  await ctx.close();
}

for (const scheme of ["light", "dark"]) {
  const { ctx, page } = await signedIn(scheme);
  await page.fill('input[name="key"]', KEYS.operator);
  await page.click('button[type="submit"]');
  await page.waitForSelector("table");
  await page.waitForTimeout(800);
  await page.locator("tr[data-id]").first().click(); // open one run's state timeline
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/control-center-${scheme}.png`, fullPage: true });
  await ctx.close();
}

const headers = { ...bearer(KEYS.operator), "Content-Type": "application/json" };
const res = await fetch(`${API}/api/capabilities/open_member_subaccount/invoke`, {
  method: "POST",
  headers,
  body: JSON.stringify({ params: { memberId: "23456", initialDeposit: "25.00" }, supervised: true }),
});
const run = await res.json();
if (run.state !== "AWAITING_HUMAN") throw new Error("expected a paused run, got " + JSON.stringify(run));

const { ctx, page } = await signedIn();
await page.fill('input[name="key"]', KEYS.operator);
await page.click('button[type="submit"]');
await page.waitForSelector(".inbox-row");
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/control-center-inbox.png` });

await page.goto(API + run.intervention.operatorUrl);
await page.waitForSelector("#panel:not([style*='none'])");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/operator-console.png`, fullPage: true });
await ctx.close();

await fetch(`${API}${run.intervention.operatorUrl}api/resume`, { method: "POST", headers, body: JSON.stringify({ decision: "decline" }) });

const big = await (
  await fetch(`${API}/api/capabilities/open_member_subaccount/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({ params: { memberId: "23456", initialDeposit: "15000.00" }, supervised: true }),
  })
).json();
if (big.intervention?.kind !== "task") throw new Error("expected a supervisor task, got " + JSON.stringify(big));
{
  const { ctx, page } = await signedIn();
  await page.fill('input[name="key"]', KEYS.operator);
  await page.click('button[type="submit"]');
  await page.waitForSelector("table");
  await page.goto(API + big.intervention.operatorUrl);
  await page.waitForSelector("#panel:not([style*='none'])");
  await page.waitForTimeout(1500);
  await page.fill("input[type=password]", "1234"); // shows masking; never submitted
  await page.screenshot({ path: `${OUT}/operator-console-supervisor-task.png`, fullPage: true });
  await ctx.close();
}
await fetch(`${API}${big.intervention.operatorUrl}api/resume`, { method: "POST", headers, body: JSON.stringify({ decision: "decline" }) });
await browser.close();
console.log(`screenshots in ${OUT}/`);
