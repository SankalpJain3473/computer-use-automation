import { z } from "zod";
import { LocatorPlanSchema } from "./locator.js";

export const InputParamSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  // Masked by value everywhere it appears in logs. Defaults from the name (see redact.isSensitiveKey).
  sensitive: z.boolean().optional(),
});
export type InputParam = z.infer<typeof InputParamSchema>;

export const OutputFieldSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

export const CheckpointConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("urlMatches"), pattern: z.string() }),
  z.object({ kind: z.literal("elementVisible"), target: LocatorPlanSchema }),
  z.object({ kind: z.literal("textVisible"), text: z.string() }),
  z.object({ kind: z.literal("httpStatus"), status: z.number() }),
]);
export type CheckpointCondition = z.infer<typeof CheckpointConditionSchema>;

export const OutcomeDefinitionSchema = z.object({
  code: z.string(),
  category: z.enum(["business_outcome", "recoverable", "failure"]),
  description: z.string(),
  detect: CheckpointConditionSchema,
  // Recoverable only. "human" makes no automated attempt; it pauses with `instruction`.
  recovery: z
    .object({
      action: z.enum(["wait", "reload", "dismiss", "human"]),
      target: LocatorPlanSchema.optional(),
      instruction: z.string().optional(),
      maxAttempts: z.number().default(2),
      waitMs: z.number().default(1500),
    })
    .refine((r) => r.action !== "dismiss" || r.target !== undefined, { message: "a dismiss recovery needs a target" })
    .refine((r) => r.action !== "human" || !!r.instruction, { message: "a human recovery needs an instruction" })
    .optional(),
});
export type OutcomeDefinition = z.infer<typeof OutcomeDefinitionSchema>;

export const StepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), urlTemplate: z.string(), description: z.string() }),
  z.object({ type: z.literal("click"), target: LocatorPlanSchema, description: z.string() }),
  z.object({ type: z.literal("fill"), target: LocatorPlanSchema, valueTemplate: z.string(), description: z.string() }),
  z.object({ type: z.literal("selectOption"), target: LocatorPlanSchema, valueTemplate: z.string(), description: z.string() }),
  z.object({
    type: z.literal("extract"),
    target: LocatorPlanSchema,
    outputName: z.string(),
    transform: z.enum(["none", "trim", "currencyToCents"]).default("none"),
    description: z.string(),
  }),
  // Checked in order after the previous step; the first match wins, no match continues.
  z.object({ type: z.literal("checkOutcomes"), outcomes: z.array(OutcomeDefinitionSchema), description: z.string() }),
  z.object({ type: z.literal("assertCheckpoint"), condition: CheckpointConditionSchema, description: z.string() }),
  z.object({ type: z.literal("confirmIrreversible"), target: LocatorPlanSchema, description: z.string() }),
]);
export type Step = z.infer<typeof StepSchema>;

export const ArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  description: z.string(),
  riskLevel: z.enum(["safe", "risky"]),
  target: z.object({
    appName: z.string(),
    allowedOrigin: z.string(),
    entryPathTemplate: z.string(),
  }),
  inputParams: z.array(InputParamSchema),
  outputs: z.array(OutputFieldSchema),
  successCheckpoint: CheckpointConditionSchema,
  steps: z.array(StepSchema),
  provenance: z.object({
    recordedAt: z.string(),
    discoveryRunId: z.string(),
    model: z.string(),
    reviewedBy: z.string().nullable().default(null),
    revisedFrom: z.number().optional(),
    approval: z
      .object({
        approvedAt: z.string(),
        unattendedIrreversible: z.boolean(),
        evidence: z.object({ runs: z.number(), confidence: z.number(), mode: z.enum(["live", "rehearsal"]) }),
      })
      .nullable()
      .default(null),
  }),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
