import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AllowlistConfig {
  allowedOrigins: string[];
  allowedActionTypes: string[];
  riskyActionMarkers: Record<string, boolean>;
  approvalPolicy: { minRuns: number; minConfidence: number };
  notes: string;
}

let cached: AllowlistConfig | undefined;

export function loadAllowlist(): AllowlistConfig {
  if (cached) return cached;
  const configPath = path.join(__dirname, "..", "..", "config", "allowlist.json");
  cached = JSON.parse(readFileSync(configPath, "utf-8"));
  return cached!;
}
