import type { Artifact } from "./schema.js";

export class ArtifactContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactContractError";
  }
}

export function unboundParams(artifact: Artifact): string[] {
  const used = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\{\{(\w+)\}\}/g)) used.add(m[1]!);
  };
  scan(artifact.target.entryPathTemplate);
  for (const step of artifact.steps) {
    if (step.type === "navigate") scan(step.urlTemplate);
    if (step.type === "fill" || step.type === "selectOption") scan(step.valueTemplate);
  }
  return artifact.inputParams.filter((p) => !used.has(p.name)).map((p) => p.name);
}

export function undeclaredPlaceholders(artifact: Artifact): string[] {
  const declared = new Set(artifact.inputParams.map((p) => p.name));
  const found = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\{\{(\w+)\}\}/g)) if (!declared.has(m[1]!)) found.add(m[1]!);
  };
  scan(artifact.target.entryPathTemplate);
  for (const step of artifact.steps) {
    if (step.type === "navigate") scan(step.urlTemplate);
    if (step.type === "fill" || step.type === "selectOption") scan(step.valueTemplate);
  }
  return [...found];
}

export function assertContract(artifact: Artifact): void {
  const unbound = unboundParams(artifact);
  if (unbound.length) {
    throw new ArtifactContractError(
      `${artifact.name}: declared input(s) ${unbound.join(", ")} are never used by any step, so callers' values would be ignored. The recording probably hard-coded a value from the discovery run.`
    );
  }
  const undeclared = undeclaredPlaceholders(artifact);
  if (undeclared.length) {
    throw new ArtifactContractError(`${artifact.name}: steps reference undeclared input(s) ${undeclared.join(", ")}.`);
  }
}
