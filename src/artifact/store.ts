import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ArtifactSchema, type Artifact } from "./schema.js";
import { assertContract } from "./validate.js";

function artifactsDir(): string {
  return process.env.ARTIFACTS_DIR ?? path.join(process.cwd(), "artifacts");
}

function fileFor(name: string, version: number): string {
  return path.join(artifactsDir(), `${name}.v${version}.json`);
}

export function saveArtifact(artifact: Artifact): string {
  ArtifactSchema.parse(artifact); // fail loudly on a malformed capability before it ever hits disk
  assertContract(artifact);
  mkdirSync(artifactsDir(), { recursive: true });
  const file = fileFor(artifact.name, artifact.version);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n", "utf-8");
  return file;
}

export function listArtifacts(): { name: string; version: number }[] {
  mkdirSync(artifactsDir(), { recursive: true });
  return readdirSync(artifactsDir())
    .map((f) => /^(.+)\.v(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1]!, version: Number(m[2]) }));
}

export function loadArtifact(name: string, version?: number): Artifact {
  let resolvedVersion = version;
  if (resolvedVersion === undefined) {
    const versions = listArtifacts()
      .filter((a) => a.name === name)
      .map((a) => a.version);
    if (versions.length === 0) throw new Error(`No saved artifact named "${name}"`);
    resolvedVersion = Math.max(...versions);
  }
  const raw = readFileSync(fileFor(name, resolvedVersion), "utf-8");
  return ArtifactSchema.parse(JSON.parse(raw));
}

export function loadLatestArtifacts(): Artifact[] {
  const names = [...new Set(listArtifacts().map((a) => a.name))].sort();
  return names.map((n) => loadArtifact(n));
}

/** Agents get the newest approved version, so a new draft doesn't displace it. */
export function loadServingArtifact(name: string): Artifact | undefined {
  const versions = listArtifacts()
    .filter((a) => a.name === name)
    .map((a) => a.version)
    .sort((x, y) => y - x);
  for (const v of versions) {
    const a = loadArtifact(name, v);
    if (a.provenance.reviewedBy !== null && a.provenance.approval !== null) return a;
  }
  return undefined;
}
