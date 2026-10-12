import { describe, it, expect } from "vitest";
import { redactDeep, redactString, maskKnownValues } from "./redact.js";

describe("redactDeep", () => {
  it("fully redacts credential-shaped fields regardless of nesting", () => {
    const out = redactDeep({ login: { username: "teller1", password: "demo", token: "abc.def.ghi" } });
    expect((out as any).login.password).toBe("[REDACTED]");
    expect((out as any).login.token).toBe("[REDACTED]");
    expect((out as any).login.username).toBe("teller1");
  });

  it("partially masks member/account identifiers, keeping the last 4 digits", () => {
    const out = redactDeep({ memberId: "1234567", accountNumber: "900001" });
    expect((out as any).memberId).toBe("***4567");
    expect((out as any).accountNumber).toBe("**0001");
  });

  it("masks numeric identifiers too, not just strings", () => {
    expect((redactDeep({ memberId: 1234567 }) as any).memberId).toBe("***4567");
  });

  it("masks known input values wherever they appear in free text", () => {
    const out = maskKnownValues({ prompt: "What is the balance for member 1234567?", n: 5 }, ["1234567"]);
    expect(out.prompt).toBe("What is the balance for member ***4567?");
    expect(out.n).toBe(5);
  });

  it("masks a known value even when it arrives as a number under a generic key", () => {
    const out = maskKnownValues({ tool: "fill", input: { value: 1234567 } }, ["1234567"]);
    expect(out.input.value).toBe("***4567");
  });

  it("masks account-number-shaped runs in free text but leaves amounts and timestamps alone", () => {
    expect(redactString("Account number 900001 is now active")).toBe("Account number **0001 is now active");
    expect(redactString("Savings Balance $4,823.10 at 2026-10-10T19:36:06Z")).toBe("Savings Balance $4,823.10 at 2026-10-10T19:36:06Z");
  });

  it("masks SSN- and card-shaped strings embedded in free text", () => {
    expect(redactString("SSN on file: 123-45-6789")).toContain("***-**-****");
    expect(redactString("card 4111 1111 1111 1111 on file")).toMatch(/\*{12}1111/);
  });
});
