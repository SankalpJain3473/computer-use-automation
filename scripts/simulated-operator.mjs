// Plays the operator through the console's HTTP API, for scripted demos.
//   node scripts/simulated-operator.mjs [--server=http://localhost:4180] [--decline]
import { readKeys, bearer } from "./keys.mjs";

const serverArg = process.argv.find((a) => a.startsWith("--server="));
const SERVER = serverArg ? serverArg.slice("--server=".length) : null;
const DECLINE = process.argv.includes("--decline");
const STANDALONE = "http://localhost:4174";
const headers = SERVER ? bearer(readKeys().operator) : {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url) => fetch(url, { headers }).then((r) => r.json());
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function findOperatorBase() {
  for (let i = 0; i < 120; i++) {
    if (SERVER) {
      const inbox = await get(`${SERVER}/api/interventions`).catch(() => []);
      if (Array.isArray(inbox) && inbox.length) return `${SERVER}${inbox[0].operatorUrl}`;
    } else {
      const state = await get(`${STANDALONE}/api/state`).catch(() => ({}));
      if (state.open) return `${STANDALONE}/`;
    }
    await sleep(1000);
  }
  throw new Error("timed out waiting for an open intervention");
}

const base = await findOperatorBase();
const state = await get(`${base}api/state`);
console.log(`[operator] intervention ${state.id} (${state.kind}): ${state.reason}`);
await sleep(1500); // a person reads the screen before deciding

if (DECLINE) {
  await post(`${base}api/resume`, { decision: "decline" });
  console.log("[operator] declined; the run stops and reports it");
  process.exit(0);
}

const confirm = state.elements.find((e) => e.name.includes("Confirm and Open Account"));
if (!confirm) {
  console.log("[operator] no confirm control on this page; leaving it for a real human");
  process.exit(1);
}
await post(`${base}api/act`, { ref: confirm.ref, type: "click" });
console.log('[operator] clicked "Confirm and Open Account" on the live session');
await sleep(500);
await post(`${base}api/resume`, { decision: "continue" });
console.log("[operator] handed control back to automation");
