import { describe, it, expect } from "vitest";
import { startOperatorServer } from "./operator-server.js";
import type { SessionManager } from "./session-manager.js";

describe("startOperatorServer", () => {
  it("moves to the next free port instead of crashing when one is taken", async () => {
    const sm = { getOpenRequest: () => undefined, controller: "automation" } as unknown as SessionManager;
    const first = await startOperatorServer(sm, 4290);
    const second = await startOperatorServer(sm, 4290);
    try {
      expect(first.url).toBe("http://localhost:4290");
      expect(second.url).toBe("http://localhost:4291");
      const state = await (await fetch(`${second.url}/api/state`)).json();
      expect(state.open).toBe(false);
    } finally {
      first.server.close();
      second.server.close();
    }
  });
});
