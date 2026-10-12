import { z } from "zod";

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("label"), text: z.string() }),
  z.object({ kind: z.literal("formField"), name: z.string() }), // the <input name=...> contract
  z.object({ kind: z.literal("text"), text: z.string(), exact: z.boolean().default(false) }),
  z.object({ kind: z.literal("tableCellByRowLabel"), labelText: z.string() }),
  z.object({ kind: z.literal("css"), selector: z.string() }), // last resort, low confidence
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorPlanSchema = z.object({
  strategies: z.array(LocatorStrategySchema).min(1),
  rationale: z.string().optional(),
});
export type LocatorPlan = z.infer<typeof LocatorPlanSchema>;
