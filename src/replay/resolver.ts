import type { Locator, Page } from "playwright";
import type { LocatorPlan, LocatorStrategy } from "../artifact/locator.js";

export class LocatorResolutionError extends Error {
  constructor(
    message: string,
    public readonly plan: LocatorPlan,
    public readonly attempts: { strategy: LocatorStrategy; matchCount: number }[]
  ) {
    super(message);
    this.name = "LocatorResolutionError";
  }
}

export interface ResolvedLocator {
  locator: Locator;
  strategyIndex: number;
  strategy: LocatorStrategy;
  driftDetected: boolean; // true if the winning strategy wasn't the first one
}

function buildLocator(page: Page, s: LocatorStrategy): Locator {
  switch (s.kind) {
    case "role":
      return page.getByRole(s.role as any, { name: s.name, exact: s.exact });
    case "label":
      return page.getByLabel(s.text);
    case "formField":
      return page.locator(`[name="${cssEscape(s.name)}"]`);
    case "text":
      return page.getByText(s.text, { exact: s.exact });
    case "tableCellByRowLabel":
      return page
        .locator("tr")
        .filter({ has: page.locator(`td`, { hasText: s.labelText }) })
        .locator("td")
        .nth(1);
    case "css":
      return page.locator(s.selector);
  }
}

function cssEscape(v: string): string {
  return v.replace(/["\\]/g, "\\$&");
}

// First strategy with exactly one match wins; an ambiguous match is never guessed between.
export async function resolveLocator(page: Page, plan: LocatorPlan): Promise<ResolvedLocator> {
  const attempts: { strategy: LocatorStrategy; matchCount: number }[] = [];
  for (let i = 0; i < plan.strategies.length; i++) {
    const strategy = plan.strategies[i]!;
    const locator = buildLocator(page, strategy);
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      count = 0;
    }
    attempts.push({ strategy, matchCount: count });
    if (count === 1) {
      return { locator, strategyIndex: i, strategy, driftDetected: i > 0 };
    }
  }
  throw new LocatorResolutionError(
    `Could not uniquely resolve locator after trying ${plan.strategies.length} strategies`,
    plan,
    attempts
  );
}
