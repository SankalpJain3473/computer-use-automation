# Evidence

Every run here is a real run against the local target app
(`src/target-app`). Member IDs and account numbers are masked in everything
written to disk: `*3456` is member 23456 and `**0003` is account 900003.

Each run folder holds:

- `log.jsonl`: the structured event log.
- `run.json`: the run's state-machine record (transitions, per-step timings,
  locator drift, human handoffs).
- `replay-result.json` or `discovery-outcome.json`: the result.
- Screenshots: `final.png`, plus `intervention-<step>.png` at the moment a
  run paused for a human.

`ledger.jsonl` has one line per finished run; reliability scores are
computed from it.

## Discovery: genuine LLM-driven runs

| Folder | What happened |
|---|---|
| `discovery-3EvQLgjD` | Goal: *look up member 12345 and read their savings and checking balance*. Model `cohere/north-mini-code:free` drove a live browser for 6 tool-calling turns: fill the member ID, click Look Up Member, `extract_by_label` on Savings and on Checking, then finish. At turn 5 the model replied in prose instead of calling a tool; the loop's guard caught it and the model called `finish` next. It produced `artifacts/lookup_member_balance.v1.json`. |

**`open_member_subaccount`: its discovery evidence was lost.**
`artifacts/open_member_subaccount.v1.json` came from a genuine discovery run
(`discovery-Nl9NaQHl`, 2026-09-27, model `inclusionai/ling-3.0-flash-fin:free`):
7 turns through search, member, form, Continue, and Confirm. That run's
folder was **deleted by mistake on 2026-10-10** while discarding a failed
attempt (an overly broad `rm`), and no backup existed. Everything else from
it survives: the artifact with every recorded locator, and the replays of it
below.

On the same day, a description-only edit removed a member ID and an amount
that the recording had copied into two step descriptions. Descriptions are
never executed, so behaviour is unchanged.

v2 (below) was made by `npm run revise` from v1's own steps, not by a new
LLM run. A fresh genuine recording was blocked by the free-tier daily request
limit; when quota allows,
`npm run discover -- --capability=open_member_subaccount --memberId=23456 --initialDeposit=60.00`
re-records it with full evidence as v3.

## Every case, with an example: `scenarios-*/README.md`

**Start here.** It's one runnable example of each case the system handles, 29
in all, run against the live app and checked against the exact result each
must produce. All 29 pass. Each case links to its own run folder.

The case that best shows human involvement is **12, the supervisor
override**. A $15,000 deposit needs a supervisor's PIN, which automation must
never hold, so the run pauses as a "task". A person types the PIN into the
live page, and it's recorded only as `[REDACTED]`: the PIN appears in no
evidence file. The run then pauses again for the irreversible confirmation,
and finishes. Case 13 covers the supervisor refusing, and 15 covers control
coming back without the PIN entered. Case 16 covers nobody answering: the
pause times out and the run ends as `OPERATOR_TIMEOUT` instead of holding a
browser session open indefinitely.

The full set covers:

- success, including tolerated locator drift on another tenant's configuration;
- each business outcome;
- each recovery kind: retry, dismissing a known interstitial, and a human
  fixing what retries couldn't;
- each human decision: confirm, decline, handing back without confirming, and
  a step only a person may do (the supervisor's PIN);
- each hard failure, including session expiry mid-flow, drift no fallback
  covers, and an operator who never answers;
- the guardrails, including a tampered artifact and a recording that ignores
  an input;
- the approval gate;
- the agent API, including an agent trying to approve its own irreversible
  action.

Regenerate with `npm run scenarios`.

## Replays: deterministic, no LLM

`lookup_member_balance`:

| Folder | Input | Result |
|---|---|---|
| `stability-lookup_member_balance-v1-*` | 10 runs, member 12345 | 10/10 success, about 730 ms each, no locator drift. `report.md` has the per-run table. |
| `stability-lookup_member_balance-v2-*` | 10 runs of **v2** | v2 was produced by `npm run revise`, which added the compliance-interstitial check to v1's recorded locators. It started from zero evidence, earned 10/10, and was approved; only then did agents move from v1 to v2. |
| `stability-lookup_member_balance-v3-*` | 10 runs of **v3** | v3 is a revise of v2 from the `discovery-3EvQLgjD` trace. Its success checkpoint is a path pattern (`/members/<id>`), where v2's was tied to `localhost:4173`, so it runs against any deployment of the app. 10/10, approved (confidence 0.72), and it is what agents are served now. |
| `replay-x9ucrkEO` | v3 against a **second instance** (`TARGET_APP_URL=http://localhost:4199`, tenant-b skin) | The same artifact, unchanged, ran against a different host with a re-labelled button. Navigation used the run-time origin; the primary locator missed, fallback #2 matched (drift recorded), and it returned both balances: **success**. |
| `replay-ijXh22BO` | member 99999 | `business_outcome` **MEMBER_NOT_FOUND**: an answer, not a crash |
| `replay-41DSaFxO` | member 40000 | `business_outcome` **PERMISSION_DENIED** |
| `replay-1WmvA_Ov` | member 50000 (flaky) | One `CORE_TIMEOUT`, retried on the artifact's own policy, then **success** |

`open_member_subaccount`:

| Folder | Input | Result |
|---|---|---|
| `stability-open_member_subaccount-v2-*` | 10 rehearsal runs of **v2** | v2 was produced by `npm run revise`, adding the supervisor-override and compliance checks. v1's discovery trace was lost, so revise recovered the recorded steps from v1 itself. v2 started from zero evidence, earned approval, and agents moved to it. |
| `stability-open_member_subaccount-v1-*` | 10 **rehearsal** runs | 10/10 `rehearsal_complete`: each ran up to the irreversible step, proved the Confirm control resolves, and stopped. No accounts were opened. |
| `replay-yGvbIgs4` | 12345, $100 | Paused at the irreversible step (`intervention-7.png`). The operator clicked Confirm on the same live session and resumed, and the run reached **success** with `new_account_number`. |
| `replay-nSlenB5g` | 12345, $80 | **A real human session (2026-10-06).** The operator opened the console and pressed Resume *without* confirming. Replay didn't claim success; it failed with `LOCATOR_NOT_FOUND`, because the success screen never appeared. That made the contract change obvious: the engine now gives the operator an explicit Decline, checks whether the confirm actually happened, and reports `DECLINED_BY_OPERATOR` either way. A test reproduces this exact case. |
| `replay-gCPvNgsx` | $5 deposit | `business_outcome` **VALIDATION_ERROR** |
| `replay-oY-O58c4` | member 99999 | `business_outcome` **MEMBER_NOT_FOUND** |

## Agent-facing API

| Folder | What happened |
|---|---|
| `api-walkthrough-*/walkthrough.md` | The capability server driven over HTTP with real keys, step by step: (1) the tool catalog an agent receives; (2) invoke by name → typed outputs; (3) a business outcome; (4) an idempotent retry returns the original run, and the same key with different input gets `409`; (5) bad and unexpected input rejected with `400` before a browser starts; (6) an irreversible call → `202 AWAITING_HUMAN`. While it waits, the agent tries to approve its own action (`403`), tries a "supervised" run (`403`), and an unauthenticated call gets `401`. Then the operator confirms, the agent long-polls, and the run reaches `COMPLETED` (`INITIALIZED → RUNNING → AWAITING_HUMAN → RUNNING → COMPLETED`); (7) the same capability, operator declines → `DECLINED_BY_OPERATOR`. |
| `server-runs/` | The per-run evidence for those server-invoked runs. |
| `agent-demo-*` | *Pending the daily LLM quota reset.* `npm run agent-demo` hands a real LLM the catalog and records which tools it chose to call. |

## Approval

Every version was approved against its own stability evidence above
(`lookup_member_balance` v1–v3, `open_member_subaccount` v1–v2), under the
reviewer name `demo-reviewer`. Re-run `npm run approve` with a real name
to replace it. `open_member_subaccount` is approved for agent invocation
only: its irreversible step still pauses for a human on every run.
Unattended execution was **refused** on rehearsal-only evidence.

## UI

`ui/` holds screenshots of:

- the sign-in page refusing an agent key;
- the control center, light and dark, with runs filterable by who started them;
- the operator inbox with a run waiting;
- the operator takeover console;
- the console during a supervisor-override task, with the PIN field masked.

All were captured by `node scripts/ui-screenshots.mjs`, which signs in through
the real login page.

## Housekeeping on 2026-10-10

Removed:

- `stdout.txt` files from three older replays. The console echo printed raw
  member IDs, a leak now fixed; `log.jsonl` was always redacted.
- One run killed while paused, which left only partial evidence.
- Recordings re-made after the redaction and parameterization fixes, and
  their ledger lines.

## Housekeeping on 2026-10-11

A sweep for unmasked member IDs found two spots written before those fixes:

- a step description copied from v1 in four replay logs;
- the input echo in four older stability `report.json` files.

All of them were masked in place to the same `*NNNN` form the redactor writes.
Nothing else in those files changed. Runs made with the current code had no
such leaks.
