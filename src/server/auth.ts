import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

// Agents may only call approved capabilities; anything a person must do (take over, confirm, run drafts) needs the operator role.

export type Role = "agent" | "operator";
export interface Keys {
  agent: string;
  operator: string;
}

const COOKIE = "cc_operator";

/** From env (AGENT_API_KEY / OPERATOR_API_KEY), else .keys.json, created on first use. */
export function loadKeys(): Keys {
  if (process.env.AGENT_API_KEY && process.env.OPERATOR_API_KEY) {
    return { agent: process.env.AGENT_API_KEY, operator: process.env.OPERATOR_API_KEY };
  }
  const file = path.join(process.cwd(), ".keys.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as Keys;
  const keys: Keys = {
    agent: `agt_${randomBytes(18).toString("base64url")}`,
    operator: `op_${randomBytes(18).toString("base64url")}`,
  };
  writeFileSync(file, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  return keys;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function presented(req: Request): string | undefined {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.headers.cookie ?? "";
  return new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookie)?.[1];
}

export function roleForKey(key: string | undefined, keys: Keys): Role | undefined {
  if (!key) return undefined;
  if (same(key, keys.operator)) return "operator";
  if (same(key, keys.agent)) return "agent";
  return undefined;
}

export function roleOf(req: Request, keys: Keys): Role | undefined {
  return roleForKey(presented(req), keys);
}

export function requireRole(keys: Keys, ...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = roleOf(req, keys);
    if (!role) {
      // People in a browser get the sign-in page; API clients always get a 401.
      const isApi = req.originalUrl.startsWith("/api/") || req.originalUrl.includes("/api/");
      if (req.method === "GET" && !isApi && req.accepts(["html", "json"]) === "html") {
        res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
        return;
      }
      res.status(401).json({ error: "UNAUTHENTICATED", message: "Send Authorization: Bearer <key>." });
      return;
    }
    if (!allowed.includes(role)) {
      res.status(403).json({ error: "FORBIDDEN_FOR_ROLE", message: `The ${role} role can't do this.` });
      return;
    }
    res.locals.role = role;
    next();
  };
}

export function setOperatorCookie(res: Response, key: string): void {
  res.setHeader("Set-Cookie", `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`);
}

export function clearOperatorCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`);
}
