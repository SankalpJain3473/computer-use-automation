# Agent API walkthrough

Against `http://localhost:4180`, 2026-10-11T04:45:10.833Z. Member IDs and account numbers are masked.

## 1. Discover: what an agent is offered (`GET /api/capabilities?format=openai`)

```json
[
  {
    "type": "function",
    "function": {
      "name": "lookup_member_balance",
      "description": "Look up a member by ID and read their current savings and checking balances. On success returns: savings_balance, checking_balance. May instead return a business outcome (a valid answer, not an error): MEMBER_NOT_FOUND (No member record exists for the given ID); PERMISSION_DENIED (This teller role is not authorized to view a restricted member).",
      "parameters": {
        "type": "object",
        "properties": {
          "memberId": {
            "type": "string",
            "description": "The member ID to look up",
            "pattern": "^\\d+$"
          }
        },
        "required": [
          "memberId"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "open_member_subaccount",
      "description": "Open a new sub-account for an existing member with a specified initial deposit, and reach the confirmation/success screen. On success returns: new_account_number. May instead return a business outcome (a valid answer, not an error): MEMBER_NOT_FOUND (No member record exists for the given ID); PERMISSION_DENIED (This teller role is not authorized to view a restricted member); VALIDATION_ERROR (Initial deposit did not meet the minimum required amount); DECLINED_BY_OPERATOR (a human operator declined the irreversible action; nothing was changed). Some calls need a person to act before they can continue (SUPERVISOR_OVERRIDE: A deposit this large needs a supervisor's override); those return AWAITING_HUMAN until someone does, or DECLINED_BY_OPERATOR if they refuse. Performs an irreversible action: every call pauses for a human operator to confirm, so the response may be AWAITING_HUMAN; poll the run until it finishes.",
      "parameters": {
        "type": "object",
        "properties": {
          "memberId": {
            "type": "string",
            "description": "The member ID to open the sub-account for",
            "pattern": "^\\d+$"
          },
          "initialDeposit": {
            "type": "string",
            "description": "Initial deposit amount in USD, e.g. \"50.00\"",
            "pattern": "^\\d+(\\.\\d{1,2})?$"
          }
        },
        "required": [
          "memberId",
          "initialDeposit"
        ],
        "additionalProperties": false
      }
    }
  }
]
```

## 2. Invoke by name with typed args: `lookup_member_balance`

HTTP 200, state **COMPLETED**
```json
{
  "status": "success",
  "outputs": {
    "savings_balance": "$4,823.10",
    "checking_balance": "$1,210.55"
  },
  "stepsExecuted": 5
}
```

## 3. A business outcome is an answer, not an error

HTTP 200, state **BUSINESS_OUTCOME**: `{
  "status": "business_outcome",
  "code": "MEMBER_NOT_FOUND",
  "description": "No member record exists for the given ID",
  "stepsExecuted": 3
}`

## 4. Retrying with the same idempotency key returns the original run

HTTP 200, runId Y3GaqX8F (original Y3GaqX8F), idempotent=true
Same key, different input: HTTP 409 `IDEMPOTENCY_KEY_REUSED`

## 5. Bad input is rejected before a browser is touched

`memberId: "abc"` -> HTTP 400 `INVALID_PARAMS`: Input parameter "memberId" does not match required pattern ^\d+$
unexpected `ssn` field -> HTTP 400 `UNKNOWN_PARAMS`

## 6. Irreversible action: pauses for a human, who confirms on the live session

HTTP 202, state **AWAITING_HUMAN**, intervention: {
  "id": "O8Et5rmU",
  "kind": "policy",
  "stepIndex": 7,
  "reason": "Irreversible step requires human confirmation: Confirm opening the new sub-account - irreversible from this screen",
  "operatorUrl": "/runs/sapZrDEj/operator/"
}

While it waits, separation of duties is enforced:

- The **agent** tries to approve its own irreversible action (`POST /runs/sapZrDEj/operator/api/resume`): HTTP 403 `FORBIDDEN_FOR_ROLE`
- The **agent** tries to start a "supervised" run to get around the approval gate: HTTP 403 `SUPERVISED_REQUIRES_OPERATOR`
- No key at all: HTTP 401 `UNAUTHENTICATED`

Operator (at /runs/sapZrDEj/operator/) clicked "Confirm and Open Account" and resumed.
Agent polls `GET /api/runs/sapZrDEj?wait=terminal` -> state **COMPLETED**
```json
{
  "status": "success",
  "outputs": {
    "new_account_number": "**0005"
  },
  "stepsExecuted": 9
}
```
State transitions: INITIALIZED -> RUNNING -> AWAITING_HUMAN -> RUNNING -> COMPLETED

## 7. Same capability, operator declines

HTTP 202, state **AWAITING_HUMAN**
After decline -> state **BUSINESS_OUTCOME**: `{
  "status": "business_outcome",
  "code": "DECLINED_BY_OPERATOR",
  "description": "An operator reviewed the irreversible step and declined it",
  "stepsExecuted": 8
}`
