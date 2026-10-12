import type { Page } from "playwright";
import type { CheckpointCondition } from "../artifact/schema.js";
import { resolveLocator } from "./resolver.js";

export interface ConditionContext {
  lastStatus?: number;
}

export async function evaluateCondition(
  page: Page,
  condition: CheckpointCondition,
  ctx: ConditionContext = {}
): Promise<boolean> {
  switch (condition.kind) {
    case "urlMatches":
      return new RegExp(condition.pattern).test(page.url());
    case "textVisible": {
      const count = await page.getByText(condition.text, { exact: false }).count();
      return count > 0;
    }
    case "elementVisible": {
      try {
        const resolved = await resolveLocator(page, condition.target);
        return await resolved.locator.isVisible();
      } catch {
        return false;
      }
    }
    case "httpStatus":
      return ctx.lastStatus === condition.status;
  }
}
