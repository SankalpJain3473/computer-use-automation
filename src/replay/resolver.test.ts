import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveLocator, LocatorResolutionError } from "./resolver.js";

describe("resolveLocator", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it("resolves via the first strategy when the accessible name still matches", async () => {
    await page.setContent(`<button>Confirm and Open Account</button>`);
    const resolved = await resolveLocator(page, {
      strategies: [
        { kind: "role", role: "button", name: "Confirm and Open Account", exact: true },
        { kind: "css", selector: "body button:nth-of-type(1)" },
      ],
    });
    expect(resolved.strategyIndex).toBe(0);
    expect(resolved.driftDetected).toBe(false);
  });

  it("falls back to a later strategy and reports drift when the primary one no longer matches", async () => {
    // Simulates a re-skin: the button's visible text changed but its
    // position in the DOM did not.
    await page.setContent(`<button>Open Account</button>`);
    const resolved = await resolveLocator(page, {
      strategies: [
        { kind: "role", role: "button", name: "Confirm and Open Account", exact: true },
        { kind: "css", selector: "body button:nth-of-type(1)" },
      ],
    });
    expect(resolved.strategyIndex).toBe(1);
    expect(resolved.driftDetected).toBe(true);
  });

  it("treats an ambiguous match (count > 1) as a non-match and keeps looking", async () => {
    await page.setContent(`<button>Submit</button><button>Submit</button>`);
    await expect(
      resolveLocator(page, {
        strategies: [{ kind: "role", role: "button", name: "Submit", exact: true }],
      })
    ).rejects.toBeInstanceOf(LocatorResolutionError);
  });

  it("resolves table-row values by label text regardless of column position", async () => {
    await page.setContent(`
      <table>
        <tr><td>Savings Balance</td><td>$4,823.10</td></tr>
        <tr><td>Checking Balance</td><td>$1,210.55</td></tr>
      </table>
    `);
    const resolved = await resolveLocator(page, {
      strategies: [{ kind: "tableCellByRowLabel", labelText: "Savings Balance" }],
    });
    await expect(resolved.locator.textContent()).resolves.toBe("$4,823.10");
  });
});
