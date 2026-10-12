import { describe, it, expect } from "vitest";
import { templatize, templatizeText } from "./agent-loop.js";

describe("templatize", () => {
  it("recognises a seed value however the model typed it", () => {
    const seed = { memberId: "23456", initialDeposit: "60.00" };
    expect(templatize("60", seed)).toBe("{{initialDeposit}}");
    expect(templatize("$60.00", seed)).toBe("{{initialDeposit}}");
    expect(templatize("23456", seed)).toBe("{{memberId}}");
    expect(templatize("SAVINGS_SUB", seed)).toBe("SAVINGS_SUB");
  });
});

describe("templatizeText", () => {
  it("turns this run's inputs into placeholders so no PII lands in the artifact", () => {
    expect(templatizeText("Enter member ID 23456, deposit $60.00", { memberId: "23456", initialDeposit: "60.00" })).toBe(
      "Enter member ID {{memberId}}, deposit ${{initialDeposit}}"
    );
  });

  it("leaves text without seed values alone", () => {
    expect(templatizeText("Click Continue", { memberId: "23456" })).toBe("Click Continue");
  });
});
