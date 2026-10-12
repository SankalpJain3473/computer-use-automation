# Scenario catalog

29/29 cases produced exactly the expected result. Run on 2026-10-11T05:05:22.961Z against `http://localhost:4173` with `npm run scenarios`.

Artifacts under test: lookup_member_balance v3, open_member_subaccount v2. Member IDs are masked. Scenario runs are tagged `scenario` in the ledger and never count toward reliability scores, because their failures are injected on purpose.

| # | Case | Input | Expected | Actual | |
|---|---|---|---|---|---|
| 1 | **Success**: Look up a member and return typed outputs | lookup_member_balance, member *2345 | `success` | `success` | pass |
| 2 | **Success**: Another tenant renamed a button; a fallback locator still finds it | member *2345 on tenant B ("Look Up Member" button relabelled "Find Member") | `success` | `success` | pass |
| 3 | **Success**: Rehearsal: exercise a risky flow without doing the irreversible thing | open_member_subaccount in rehearsal mode | `rehearsal_complete` | `rehearsal_complete` | pass |
| 4 | **Business outcome**: No such member | member *9999 | `business_outcome:MEMBER_NOT_FOUND` | `business_outcome:MEMBER_NOT_FOUND` | pass |
| 5 | **Business outcome**: Teller not authorized for this member | member *0000 (restricted) | `business_outcome:PERMISSION_DENIED` | `business_outcome:PERMISSION_DENIED` | pass |
| 6 | **Business outcome**: The bank app rejects the input | open_member_subaccount, $5.00 deposit (minimum $25) | `business_outcome:VALIDATION_ERROR` | `business_outcome:VALIDATION_ERROR` | pass |
| 7 | **Recoverable**: Core system times out once; retried automatically | member *0000 (first load per session returns 504) | `success` | `success` | pass |
| 8 | **Recoverable**: A known interstitial is dismissed | member *0000 (compliance notice must be acknowledged first) | `success` | `success` | pass |
| 9 | **Recoverable**: Retries run out; a person fixes it on the live page | member *0002 (fails 3 times per session, retry budget is 2) | `success` | `success` | pass |
| 10 | **Human handoff**: Irreversible step: a human confirms on the live session | open_member_subaccount, member *2345, $40.00 | `success` | `success` | pass |
| 11 | **Human handoff**: Irreversible step: the human declines | open_member_subaccount, operator clicks Decline | `business_outcome:DECLINED_BY_OPERATOR` | `business_outcome:DECLINED_BY_OPERATOR` | pass |
| 12 | **Human handoff**: A step only a person may do: supervisor override PIN | open_member_subaccount, $15,000.00 deposit (≥ $10,000 needs a supervisor) | `success` | `success` | pass |
| 13 | **Human handoff**: The supervisor refuses the override | $15,000.00 deposit; supervisor clicks Decline | `business_outcome:DECLINED_BY_OPERATOR` | `business_outcome:DECLINED_BY_OPERATOR` | pass |
| 14 | **Human handoff**: Control handed back without confirming | operator presses Resume but never clicks Confirm | `business_outcome:DECLINED_BY_OPERATOR` | `business_outcome:DECLINED_BY_OPERATOR` | pass |
| 15 | **Hard failure**: Control handed back but the required step wasn't done | $15,000.00 deposit; operator resumes without entering a PIN | `failure:HUMAN_TASK_INCOMPLETE` | `failure:HUMAN_TASK_INCOMPLETE` | pass |
| 16 | **Hard failure**: Nobody answers a pause | open_member_subaccount; no operator responds before the timeout (2s here, 15 min by default) | `failure:OPERATOR_TIMEOUT` | `failure:OPERATOR_TIMEOUT` | pass |
| 17 | **Hard failure**: Retries run out and the person gives up | member *0002, operator clicks Give up | `failure:RECOVERY_EXHAUSTED` | `failure:RECOVERY_EXHAUSTED` | pass |
| 18 | **Hard failure**: Session expires mid-flow | member *0000 (loading the record ends the session) | `failure:SESSION_EXPIRED` | `failure:SESSION_EXPIRED` | pass |
| 19 | **Hard failure**: A tenant changed a label no fallback covers | member *2345 on tenant C ("Savings Balance" row relabelled "Share Savings") | `failure:LOCATOR_NOT_FOUND` | `failure:LOCATOR_NOT_FOUND` | pass |
| 20 | **Hard failure**: Malformed input | memberId "abc" | `failure:INVALID_PARAMS` | `failure:INVALID_PARAMS` | pass |
| 21 | **Guardrail**: A tampered artifact tries to leave the allowed app | lookup_member_balance with a step navigating to https://example.com/ | `failure:ORIGIN_NOT_ALLOWED` | `failure:ORIGIN_NOT_ALLOWED` | pass |
| 22 | **Guardrail**: A recording that ignores a caller's input is refused | open_member_subaccount whose deposit step types a fixed 60 | `rejected` | `rejected` | pass |
| 23 | **Lifecycle**: Approval is refused without evidence | approve a version with fewer than 8 counted runs | `refused` | `refused` | pass |
| 24 | **Agent API**: An agent discovers what it can call | GET /api/capabilities?format=openai (agent key) | `approved tools only` | `approved tools only` | pass |
| 25 | **Agent API**: Invoke a capability by name with typed args | POST /api/capabilities/lookup_member_balance/invoke | `200 COMPLETED` | `200 COMPLETED` | pass |
| 26 | **Agent API**: A retried request doesn't run twice | same idempotency key twice, then with different input | `same run, then 409` | `same run, then 409` | pass |
| 27 | **Agent API**: An undeclared field is rejected | invoke with an extra `ssn` field | `400 UNKNOWN_PARAMS` | `400 UNKNOWN_PARAMS` | pass |
| 28 | **Agent API**: An agent can't approve its own irreversible action | agent key: resume its own paused run; start a supervised run; no key at all | `403, 403, 401` | `403, 403, 401` | pass |
| 29 | **Agent API**: The agent learns the human's decision | agent long-polls the paused run; operator declines | `BUSINESS_OUTCOME DECLINED_BY_OPERATOR` | `BUSINESS_OUTCOME DECLINED_BY_OPERATOR` | pass |

## Details

### 01-happy-path: Look up a member and return typed outputs

The production path: a recorded flow replayed with new inputs, no LLM, outputs returned to the caller.

- outputs: {"savings_balance":"$4,823.10","checking_balance":"$1,210.55"}
- evidence: [`01-happy-path/`](./01-happy-path/)

### 02-drift-absorbed: Another tenant renamed a button; a fallback locator still finds it

Same vendor product, different configuration. The ranked locator plan falls back from role+name to the recorded position, and the drift is recorded rather than hidden.

- drift recorded: step 1 (click) resolved by fallback strategy #2
- evidence: [`02-drift-absorbed/`](./02-drift-absorbed/)

### 04-rehearsal: Rehearsal: exercise a risky flow without doing the irreversible thing

How a risky capability earns approval evidence without opening real accounts: run up to the irreversible step, prove its control resolves, stop.

- stopped before step 7; confirm control resolved via strategy #0
- evidence: [`04-rehearsal/`](./04-rehearsal/)

### 05-not-found: No such member

A legitimate answer the caller needs, not a crash (the brief's own example).

- evidence: [`05-not-found/`](./05-not-found/)

### 06-permission-denied: Teller not authorized for this member

Permission denials are a normal state of a bank system and an answer the agent must relay.

- evidence: [`06-permission-denied/`](./06-permission-denied/)

### 07-validation-error: The bank app rejects the input

A validation error from the app is reported as what it is, before anything irreversible is reached.

- evidence: [`07-validation-error/`](./07-validation-error/)

### 10-transient-retried: Core system times out once; retried automatically

Transient slowness is handled by the artifact's own retry policy, without bothering a person.

- recovered from CORE_TIMEOUT after 1 automatic attempt(s)
- evidence: [`10-transient-retried/`](./10-transient-retried/)

### 11-interstitial-dismissed: A known interstitial is dismissed

The brief's "dismiss a known interstitial": the artifact names the screen and the control that clears it, so replay clicks through it.

- dismissed COMPLIANCE_NOTICE
- outputs: {"savings_balance":"$3,100.50","checking_balance":"$777.00"}
- evidence: [`11-interstitial-dismissed/`](./11-interstitial-dismissed/)

### 12-exhausted-human-fixes: Retries run out; a person fixes it on the live page

Retry, then alert: automation doesn't give up silently, and only a condition that outlives its retries reaches a person, who acts on the same session.

- intervention kind: fault, human actions: 1
- transitions: INITIALIZED → RUNNING → AWAITING_HUMAN → RUNNING → COMPLETED
- evidence: [`12-exhausted-human-fixes/`](./12-exhausted-human-fixes/)

### 03-irreversible-confirmed: Irreversible step: a human confirms on the live session

An unattended agent must not open accounts by itself. Replay pauses, the operator confirms on the very same page, and automation finishes the flow.

- transitions: INITIALIZED → RUNNING → AWAITING_HUMAN → RUNNING → COMPLETED
- human actions recorded: 1
- evidence: [`03-irreversible-confirmed/`](./03-irreversible-confirmed/)

### 08-declined: Irreversible step: the human declines

A person saying no is an answer, and nothing irreversible happens.

- evidence: [`08-declined/`](./08-declined/)

### 26-supervisor-override: A step only a person may do: supervisor override PIN

Automation isn't allowed to hold or type a supervisor's PIN, so it doesn't try: it pauses immediately with an instruction. A supervisor enters the PIN on the same live page, and the flow continues to the irreversible step, which still needs its own confirmation. The PIN is never recorded.

- handoffs, in order: task → policy (supervisor task, then irreversible confirmation)
- transitions: INITIALIZED → RUNNING → AWAITING_HUMAN → RUNNING → AWAITING_HUMAN → RUNNING → COMPLETED
- PIN in evidence: no; the fill is recorded as [REDACTED]
- evidence: [`26-supervisor-override/`](./26-supervisor-override/)

### 27-override-declined: The supervisor refuses the override

A supervisor saying no is an answer the calling agent needs, and nothing is opened.

- evidence: [`27-override-declined/`](./27-override-declined/)

### 09-resumed-unconfirmed: Control handed back without confirming

From a real session: the engine checks whether the action happened instead of assuming it did.

- evidence: [`09-resumed-unconfirmed/`](./09-resumed-unconfirmed/)

### 28-override-not-done: Control handed back but the required step wasn't done

The engine checks the page instead of trusting "done": the override screen is still there, so it stops rather than carrying on.

- failed at step 6 (Distinguish a validation error from a successful transition to the confirmation screen)
- expected: happy path continuation
- observed: Control came back but "SUPERVISOR_OVERRIDE" still needs doing
- evidence: [`28-override-not-done/`](./28-override-not-done/)

### 29-no-operator-response: Nobody answers a pause

A paused run can't hold a browser session and the app's login forever. It times out, nothing irreversible happens, and the session is released.

- hand-back recorded as: timeout
- evidence: [`29-no-operator-response/`](./29-no-operator-response/)

### 13-exhausted-given-up: Retries run out and the person gives up

When neither automation nor a person can clear it, the run stops with a clear, debuggable failure.

- failed at step 2 (Check the member record loaded)
- expected: transient condition to clear after retry
- observed: Core banking service timed out loading the member record
- evidence: [`13-exhausted-given-up/`](./13-exhausted-given-up/)

### 14-session-expired: Session expires mid-flow

Re-authentication belongs to the connection layer, not to a recorded flow, so the capability stops and says so.

- failed at step 2 (Check the member record loaded)
- expected: happy path continuation
- observed: Session expired mid-flow; re-authenticate and retry
- evidence: [`14-session-expired/`](./14-session-expired/)

### 15-drift-beyond-fallbacks: A tenant changed a label no fallback covers

Replay never guesses which value is the balance. It stops and reports what it looked for and what it found: exactly the signal for a per-tenant override.

- failed at step 3 (Extract member {{memberId}}'s savings balance)
- expected: exactly one match for the recorded locator strategies
- observed: [{"strategy":{"kind":"tableCellByRowLabel","labelText":"Savings Balance"},"matchCount":0}]
- evidence: [`15-drift-beyond-fallbacks/`](./15-drift-beyond-fallbacks/)

### 16-invalid-input: Malformed input

Bad input is rejected by the artifact's contract before anything is clicked.

- failed at step -1 (input validation)
- expected: all required parameters present and well-formed
- observed: Input parameter "memberId" does not match required pattern ^\d+$
- evidence: [`16-invalid-input/`](./16-invalid-input/)

### 17-off-allowlist: A tampered artifact tries to leave the allowed app

The allowlist is enforced on every navigation, whatever the artifact says.

- failed at step 0 (tampered step)
- expected: an action inside the allowlist
- observed: Origin https://example.com is not in the allowlist (http://localhost:4173, http://localhost:4198, http://localhost:4199)
- evidence: [`17-off-allowlist/`](./17-off-allowlist/)

### 18-hardcoded-input: A recording that ignores a caller's input is refused

The real bug this guards against: the model typed 60 for a seed of 60.00, which would have deposited $60 on every replay.

- open_member_subaccount: declared input(s) initialDeposit are never used by any step, so callers' values would be ignored. The recording probably hard-coded a value from the discovery run.

### 19-approval-refused: Approval is refused without evidence

A reviewer's name isn't enough; approval needs replay evidence.

- lookup_member_balance v9000 needs at least 8 runs with confidence >= 0.7 to be approved; it has no recorded replays. Run `npm run stability -- --capability=lookup_member_balance ...` first.

### 20-catalog: An agent discovers what it can call

Tool definitions are generated from the approved artifacts, so they can't drift from what replays.

- tools offered: lookup_member_balance, open_member_subaccount

### 21-invoke: Invoke a capability by name with typed args

How an agent uses a recorded capability in production.

- served version v3
- outputs: {"savings_balance":"$4,823.10","checking_balance":"$1,210.55"}

### 22-idempotency: A retried request doesn't run twice

An agent retrying a timed-out "open account" must get the original run back, not a second account.

- retry idempotent=true
- reuse with different input: IDEMPOTENCY_KEY_REUSED

### 23-unknown-input: An undeclared field is rejected

Sending data a capability doesn't declare is a contract violation, and PII shouldn't be accepted just because it was sent.


### 24-separation-of-duties: An agent can't approve its own irreversible action

The approval gate means nothing if the caller can confirm for itself.

- irreversible call returned 202 AWAITING_HUMAN
- self-approval: FORBIDDEN_FOR_ROLE
- supervised by agent: SUPERVISED_REQUIRES_OPERATOR

### 25-agent-waits-out-human: The agent learns the human's decision

Paused is a state, not an error: the agent polls until a person decides.

