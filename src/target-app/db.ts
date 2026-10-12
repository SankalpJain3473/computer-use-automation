export interface Member {
  id: string;
  name: string;
  savingsBalanceCents: number;
  checkingBalanceCents: number;
  restricted?: boolean; // permission-denied page (403)
  flakyFailures?: number; // first N loads per session time out (504), then the record loads
  expiresSession?: boolean; // loading the record kills the session (401 mid-flow)
  complianceNotice?: boolean; // an interstitial must be acknowledged once per session
}

export const members = new Map<string, Member>([
  ["12345", { id: "12345", name: "Jordan Alvarez", savingsBalanceCents: 482310, checkingBalanceCents: 121055 }],
  ["23456", { id: "23456", name: "Priya Natarajan", savingsBalanceCents: 990102, checkingBalanceCents: 45012 }],
  ["40000", { id: "40000", name: "Restricted Account Holder", savingsBalanceCents: 100000, checkingBalanceCents: 0, restricted: true }],
  ["50000", { id: "50000", name: "Sam Flake", savingsBalanceCents: 733200, checkingBalanceCents: 20000, flakyFailures: 1 }],
  ["50001", { id: "50001", name: "Robin Flake", savingsBalanceCents: 561000, checkingBalanceCents: 8800, flakyFailures: 1 }],
  ["50002", { id: "50002", name: "Casey Outage", savingsBalanceCents: 120000, checkingBalanceCents: 4500, flakyFailures: 3 }],
  ["60000", { id: "60000", name: "Taylor Timeout", savingsBalanceCents: 250000, checkingBalanceCents: 1000, expiresSession: true }],
  ["80000", { id: "80000", name: "Morgan Notice", savingsBalanceCents: 310050, checkingBalanceCents: 77700, complianceNotice: true }],
]);

// Per session, so every run sees the same "fails N times, then works".
export const flakyServed = new Map<string, number>();

export interface SubAccount {
  accountNumber: string;
  memberId: string;
  type: string;
  initialDepositCents: number;
}

export const subAccounts: SubAccount[] = [];
let nextAccountNumber = 900001;
export function createSubAccount(memberId: string, type: string, initialDepositCents: number): SubAccount {
  const acct: SubAccount = { accountNumber: String(nextAccountNumber++), memberId, type, initialDepositCents };
  subAccounts.push(acct);
  return acct;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
