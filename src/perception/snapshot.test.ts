import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { captureSnapshot } from "./snapshot.js";

// Regression test for a real bug hit during development: page.evaluate with a
// compiled TS closure throws `ReferenceError: __name is not defined` inside
// the browser's isolated realm (an esbuild/tsx artifact). captureSnapshot
// works around it by evaluating a plain JS string instead - this test proves
// that actually works against a live page, not just that it type-checks.
describe("captureSnapshot", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("reads roles, accessible names, and a css fallback from legacy table markup without throwing", async () => {
    await page.setContent(`
      <table>
        <tr><td>Member ID</td><td><input type="text" name="memberId"/></td></tr>
      </table>
      <button>Look Up Member</button>
      <a href="/logout">Log Out</a>
    `);
    const snapshot = await captureSnapshot(page);
    const names = snapshot.elements.map((e) => e.name);
    expect(names).toContain("Member ID");
    expect(names).toContain("Look Up Member");
    expect(names).toContain("Log Out");

    const memberIdField = snapshot.elements.find((e) => e.name === "Member ID");
    expect(memberIdField?.plan.strategies.some((s) => s.kind === "formField")).toBe(true);
  });
});
