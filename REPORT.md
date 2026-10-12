# REPORT

The system has four stages. A model **discovers** a flow once. The flow
becomes a typed **capability artifact**. The artifact **replays
deterministically**, with no model involved. **Agents invoke** it by name, and
a person can take over the live session whenever judgment is needed.
Stretch goals, kept to the two the brief allows: an **agent-facing capability
interface**, and **confidence & approval**. Multi-run stability is the
evidence that feeds approval, not a separate feature.

## 1. Architecture

```
            discovery (LLM)                        production path (no LLM)
goal ─▶ observe → decide → act ─▶ artifact ─▶ stability ─▶ approve ─▶ capability server ◀─ agents (typed tools)
             │   (tool calls)      (draft)    (ledger)    (gate)           │
        perception: roles,                                          run executor ─▶ replay engine
        names, label text                                                │            │
             │                                                     run state machine  locators, outcomes,
             ▼                                                           │            guardrails
      live Playwright page ◀──────────────── same session ───────────────┴─ operator console (human)
```

One Node/TypeScript process, no queues or services. The brief explicitly
doesn't reward scaling infrastructure, and nothing here needs it. The
boundaries that matter are kept sharp:

- **Discovery and replay share only perception and locator primitives.** The
  LLM loop and the engine never call each other, which is what makes "no
  model in the loop" true by construction.
- **One run executor** (`src/runs/executor.ts`) is used by the CLI, the
  stability sweeps, and the server alike. Every run, whoever triggers it, gets
  the same fresh browser context, authenticated session, state machine,
  evidence, and cleanup.
- **A state machine per run** (`src/runs/tracker.ts`):
  `INITIALIZED → RUNNING ⇄ AWAITING_HUMAN → COMPLETED | BUSINESS_OUTCOME | FAILED`.
  Illegal transitions throw. Every transition is written to the run's
  `run.json` with a time and a reason, and every finished run appends one line
  to a ledger. The record answers "what is this run doing, and who controls
  it?", and the ledger is what reliability is computed from.

**Choices.** *Perception*: an accessibility/DOM snapshot (roles, names, label
text), not pixel coordinates. It works on legacy markup with no test IDs,
replays deterministically, and matches what an OS accessibility tree gives on
desktop (§4). *LLM*: OpenRouter with OpenAI-style tool calling; the free
default was picked by probing current models on real observations from the
app. *Target app*: a local, deliberately legacy credit-union console. It can
produce every runtime error the brief names on demand, which a public sandbox
can't.

## 2. Artifact schema

An artifact (`src/artifact/schema.ts`) is a **capability contract**, not a
step recording.

- **`inputParams` / `outputs`**: typed, named, and described, with a
  validation `pattern` and a `sensitive` flag marking PII inputs. A caller
  learns what to pass and what comes back without reading any steps.
- **`steps`**: a small, closed set of kinds (`navigate`, `click`, `fill`,
  `selectOption`, `extract`, `checkOutcomes`, `assertCheckpoint`,
  `confirmIrreversible`). Each targeting step carries a **ranked locator
  plan**: role + accessible name, then form-field `name`, then visible text,
  then table-row-by-label, with a CSS path last. It records the reasoning for
  the ranking, and replay reports which strategy won.
- **The outcome taxonomy is schema, not exception handling.** Each anticipated
  state is a named outcome with a category (`business_outcome`,
  `recoverable`, or `failure`), a detection condition, and, for recoverable
  ones, a retry policy.
- **An irreversible action is its own step type**
  (`confirmIrreversible` + `riskLevel`), so policy can single it out
  precisely instead of guessing from step descriptions.
- **`provenance`** records the discovery run, the model, the reviewer, and an
  `approval` record with the evidence it was granted on (§6).

Agents see the same artifact as a tool definition, generated from it
(`src/server/catalog.ts`): JSON Schema for inputs and outputs, plus which
business outcomes can come back and whether the call pauses for a human. No
hand-written description exists to drift out of date.

**Contract checks a schema can't express** (`src/artifact/validate.ts`) run
on every save. They reject artifacts where a declared input drives no step,
or a step uses an undeclared input. This caught a real bug during
development. The model typed the seed deposit `"60.00"` as the number `60`,
the recorder failed to match it to the parameter, and the artifact would
have deposited $60 on every replay regardless of input. The recorder now
matches seed values numerically, and the check refuses to save such an
artifact at all.

**Approved versions are never edited in place.** Changing what a capability
checks for produces a new draft (`npm run revise` re-applies the current
checks to the originally recorded locators). Agents are always served the
newest *approved* version, so a draft never displaces a working capability
until it has earned approval itself. `lookup_member_balance` went v1 → v2 this
way when the compliance-interstitial check was added, and v2 → v3 when its
success checkpoint stopped naming a specific host.

**Login is never a step**: credentials must not enter a versioned artifact,
and auth is a connection concern. **Recordings are augmented, not used raw**
(`src/capabilities/definitions.ts`): a goal-seeking run only sees the happy
path, so known outcome checks are layered onto its real locators, matched by
recorded element text rather than position. Step descriptions come from the
model's stated reasons, so this run's input values become `{{param}}`
placeholders, which keeps PII out of the artifact.

## 3. Determinism & error handling

Replay never calls an LLM. It is deterministic because:

1. It starts from the artifact's declared entry point.
2. Locators resolve in a fixed order and require exactly one match. An
   ambiguous match counts as no match; on a financial screen it is never
   guessed.
3. Outcomes are detected from the real HTTP status of the last navigation,
   not by scraping page text.
4. A run moves through explicit phases: validate inputs and policy, then
   execute steps, then verify the success checkpoint and package outputs.

The result contract has four shapes:

- **`success`**, with typed outputs.
- **`business_outcome`**: a named, valid answer such as `MEMBER_NOT_FOUND`,
  `PERMISSION_DENIED`, `VALIDATION_ERROR`, or `DECLINED_BY_OPERATOR`.
- **`failure`**: the step, what was expected, what was observed, and an
  error code.
- **`rehearsal_complete`**: a rehearsal run reached the irreversible step,
  proved its control resolves, and stopped before performing it.

`AWAITING_HUMAN` is not a result. It is a live run state, so callers poll it.
Recoverable conditions follow the artifact's own policy:

- **wait**: give a slow load time;
- **reload**: retry a transient error;
- **dismiss**: click the named control on a *known* interstitial, such as a
  compliance notice. An unknown screen is never dismissed blindly.

If that fails, the run escalates to a human (§5), and only then fails with
`RECOVERY_EXHAUSTED`. Retries happen at the step
level only. **Whole runs are never auto-retried**: replaying a
non-idempotent banking flow from the top risks doing it twice. Agent retries
are made safe with **idempotency keys** instead: the same key returns the
original run, and the same key with different input gets `409`.

**Drift** is secondary here (the UI is stable), so the bias is to *detect* it
cheaply rather than self-heal. Any fallback-locator win is logged per step and
counted per version in the reliability stats.

**Every case has a runnable example.** `npm run scenarios` is an executable
spec of 29 cases against the live app. It covers each business outcome,
recovery kind, human decision, and hard failure, plus the guardrails and the
agent API, checking each against its exact expected result with per-case
evidence. Those runs inject faults on purpose, so they are excluded from
reliability scoring.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam sits between perception, which produces
`{role, name, candidate locators}` from whatever is on screen, and the
artifact's ranked locator plan. A *legacy web* app needs nothing new: the
target app here *is* one. `tableCellByRowLabel` exists because "read the
value next to this label in a table" is the dominant legacy pattern, and
test-ID assumptions miss it. A *desktop* app swaps the DOM query for an OS
accessibility tree (UI Automation on Windows, AXUIElement on macOS), which
yields the same shape. The artifact format, engine, outcome taxonomy, run
state machine, and handoff are all unchanged; the locator plan just gains a
strategy kind such as `automationId`. A new surface adds a locator kind, not
a new artifact format.

**Multi-tenant reuse** (first half built). Artifacts hold paths, not hosts:
replay navigates to the origin configured at run time (`TARGET_APP_URL`), and
the success checkpoint is a path pattern. The same approved artifact ran
unchanged against a second instance on another port, with tenant B's labels,
and succeeded (`evidence/replay-x9ucrkEO`). What's left is a **base artifact
plus per-tenant overrides**: record once against a reference tenant, and
override only the locator plans or URL templates a tenant's configuration
changes. Drift, reliability, and approval, already tracked per version, would
be tracked per (tenant, version).

The two signals that design needs are already demonstrated. The stand-in app
can present two other tenants' configurations, and the scenario catalog
replays one artifact against both. On tenant B a relabelled button is
absorbed by a fallback locator, and the drift is recorded. On tenant C a
relabelled data row isn't covered by any fallback, so replay stops with what
it looked for and what it found, rather than guessing which value is the
balance. That's exactly where an override belongs.

## 5. Escalation & handoff

Four triggers reach one mechanism, each tagged with a kind:

- **`policy`**: an irreversible step on a version not cleared for unattended
  execution.
- **`task`**: the app requires something **only a person may do**. The
  example is a deposit of $10,000 or more needing a supervisor's override
  PIN. Automation must never hold or type that PIN, so it makes no attempt:
  the artifact declares the outcome with a `human` recovery and an
  instruction, and replay pauses immediately.
- **`fault`**: a recoverable condition that outlived its retries.
- **`agent`**: the discovery model calling `escalate`.

The kind matters downstream. Policy and task pauses are the system working
as designed and don't count against reliability; fault and agent escalations
do. One run can need several: the supervisor case pauses for the override
(`task`), then again for the irreversible confirmation (`policy`).

`SessionManager.requestIntervention` captures a screenshot and the element
map, records who, what, and why, moves the run to `AWAITING_HUMAN`, and
blocks. Automation and the human hold **one lock over one live page**; there
is never a second session. In the capability server, open interventions land
in an **operator inbox**. "Take over" opens a per-run console showing the
live page, re-captured on every poll, and the same element map the agent
perceives. Every human action executes through a live element handle on that
exact page and is recorded to the run's evidence.

The human hands back with a **decision**, not just "done". *Resume* re-checks
the page and continues. *Decline* stops the run; for an irreversible step the
caller gets `DECLINED_BY_OPERATOR`. The engine verifies rather than assumes:
if the confirm control is still on screen after hand-back, the action didn't
happen (from a real session, where an operator resumed without confirming).
If the override screen is still there, the task wasn't done
(`HUMAN_TASK_INCOMPLETE`). And it never asks a person to confirm a control
that isn't on screen. A pause can't hold a browser forever either: with no
answer within `INTERVENTION_TIMEOUT_MS` (15 minutes by default) the run ends
as `OPERATOR_TIMEOUT`, and the deadline is shown in the console. The agent
just gets `202 AWAITING_HUMAN` and long-polls the run. Simplified on purpose: the "video" is a polled screenshot, not a
co-browsing stream (allowed by the brief's scope note).

## 6. Safety

- **Allowlist** (`config/allowlist.json`): allowed origins and action types,
  checked on every navigation and after every click. Violations are hard
  failures.
- **Approval is a two-step gate on evidence**:
  - *Drafts can't be invoked by agents.* Approval needs at least 8 replays
    whose **Wilson 95% lower-bound** success rate is at least 70%. A raw rate
    misleads: 3/3 looks "100% reliable" on almost no evidence, while 10/10
    only proves "at least 72%". Each new version starts from zero evidence.
  - *Irreversible steps still pause for a human* after approval. Running them
    unattended is a separate, explicit grant that additionally needs 8 live,
    human-confirmed runs.
  - **Rehearsal mode** lets risky capabilities earn the first approval
    without performing a single irreversible action.
- **Separation of duties**, via two roles:
  - An **agent** key can list and invoke approved capabilities and poll its
    own runs. It cannot run drafts, start supervised runs, see the operator
    inbox, or open a takeover console, so it can never confirm its own
    irreversible action.
  - An **operator** (a person) signs in at `/login` and does all of those.
  - Approval sits outside the API altogether: it's a CLI action needing
    access to the repository.

  There is no registration: in a bank, staff identity comes from the
  institution's identity provider, never self sign-up.
- **Input boundary**: unknown or malformed parameters are rejected with `400`
  before a browser starts. Concurrent browser runs are capped
  (`MAX_ACTIVE_RUNS`); beyond the cap, invoke returns `429` with
  `Retry-After` rather than queueing work nobody is watching.
- **Redaction** runs on everything written to disk or stdout:
  - credential-shaped keys are removed entirely;
  - identifier keys are masked to the last 4 digits;
  - SSN-, card-, and account-number-shaped runs in free text are masked;
  - the values of inputs an artifact marks `sensitive` are masked *wherever
    they appear*, which catches a member ID inside a model's free-text
    reasoning, even when the model sends it as a JSON number;
  - whatever a person types into a password field during a handoff (the
    supervisor's PIN) is recorded only as `[REDACTED]`. It appears in no
    evidence file, and the console masks it on screen.

  Callers still receive real outputs. Logs, evidence, and dashboard listings
  get the redacted form.

**Limits.** Redaction is pattern- and value-based, so a member's *name* in
free text is not caught. Screenshots inherently contain PII; in production
they belong in encrypted, access-controlled, short-retention storage. Roles
are shared keys, not per-person identities, so the audit trail records "an
operator", not *which* operator. Production would put SSO in front and keep
the same role split. The server binds to loopback only. Idempotency keys live
in memory, so they don't survive a server restart.

## 7. Cuts

- **Automatic outcome inference and parameterization from one trace.** Known
  outcomes are authored per capability, and seed values are matched to
  parameters. Doing either generically is a research problem; the contract
  check catches the dangerous failure mode.
- **Per-tenant overrides and desktop perception**: designed in §4, not
  built, as the brief scopes them (run-time origin is built).
- **Live co-browsing**: the real mechanism with a polled-screenshot UI.
- **Durable runtime state and real identity**: idempotency keys and live run
  records are in-memory (the ledger and evidence are on disk); roles use
  shared keys rather than SSO; there's no multi-host execution.

Next, in order: per-tenant overrides with per-tenant reliability (the
brief's own top priority for this environment); durable idempotency and run
storage; SSO-backed per-person identity, so approvals and handoffs name the
human.
