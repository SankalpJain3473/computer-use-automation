// Legacy markup on purpose: tables, inline styles, no test IDs, labels as adjacent text.

function page(title: string, body: string): string {
  return `<!doctype html>
<html>
<head><title>${title}</title></head>
<body style="font-family: Arial, sans-serif;">
<table width="100%" bgcolor="#003366"><tr><td>
  <font color="white" size="4"><b>Meridian Credit Union &mdash; Teller Console</b></font>
</td></tr></table>
<br/>
${body}
</body>
</html>`;
}

export function loginPage(error?: string): string {
  return page(
    "Meridian Teller Console - Login",
    `
    ${error ? `<table bgcolor="#ffdddd"><tr><td><b>${error}</b></td></tr></table><br/>` : ""}
    <form method="POST" action="/login">
      <table border="0" cellpadding="4">
        <tr><td>Teller Username</td><td><input type="text" name="username" value="teller1"/></td></tr>
        <tr><td>Password</td><td><input type="password" name="password" value="demo"/></td></tr>
        <tr><td colspan="2"><input type="submit" value="Sign In"/></td></tr>
      </table>
    </form>
  `
  );
}

export interface Skin {
  searchButton: string;
  savingsLabel: string;
}
export const SKINS: Record<string, Skin> = {
  standard: { searchButton: "Look Up Member", savingsLabel: "Savings Balance" },
  "tenant-b": { searchButton: "Find Member", savingsLabel: "Savings Balance" }, // re-labelled button
  "tenant-c": { searchButton: "Look Up Member", savingsLabel: "Share Savings" }, // re-labelled data row
};

export function searchPage(skin: Skin, notice?: string): string {
  return page(
    "Member Search",
    `
    ${notice ? `<table bgcolor="#ffffcc"><tr><td>${notice}</td></tr></table><br/>` : ""}
    <form method="POST" action="/members/search">
      <table border="0" cellpadding="4">
        <tr><td>Member ID</td><td><input type="text" name="memberId"/></td></tr>
        <tr><td colspan="2"><input type="submit" value="${escapeHtml(skin.searchButton)}"/></td></tr>
      </table>
    </form>
    <br/><a href="/logout">Log Out</a>
  `
  );
}

export function notFoundPage(memberId: string): string {
  return page(
    "Member Not Found",
    `
    <table bgcolor="#ffdddd" border="1" cellpadding="6"><tr><td>
      <b>No member record found for ID ${escapeHtml(memberId)}.</b>
    </td></tr></table>
    <br/><a href="/members/search">Back to Search</a>
  `
  );
}

export function permissionDeniedPage(memberId: string): string {
  return page(
    "Access Denied",
    `
    <table bgcolor="#ffdddd" border="1" cellpadding="6"><tr><td>
      <b>Member ${escapeHtml(memberId)} is restricted. Your teller role is not authorized to view this record.</b><br/>
      Error Code: PERM_DENIED_ROLE
    </td></tr></table>
    <br/><a href="/members/search">Back to Search</a>
  `
  );
}

export function transientErrorPage(memberId: string): string {
  return page(
    "Service Temporarily Unavailable",
    `
    <table bgcolor="#fff3cd" border="1" cellpadding="6"><tr><td>
      <b>Core banking service timed out while loading member ${escapeHtml(memberId)}. Please retry.</b><br/>
      Error Code: CORE_TIMEOUT_504
    </td></tr></table>
    <br/><a href="/members/${encodeURIComponent(memberId)}">Retry</a>
  `
  );
}

export function complianceNoticePage(memberId: string): string {
  return page(
    "Compliance Notice",
    `
    <table bgcolor="#fff3cd" border="1" cellpadding="6"><tr><td>
      <b>Compliance notice:</b> member ${escapeHtml(memberId)} has an open KYC review. Acknowledge before viewing account details.
    </td></tr></table>
    <br/>
    <form method="POST" action="/members/${encodeURIComponent(memberId)}/acknowledge">
      <input type="submit" value="Acknowledge and Continue"/>
    </form>
  `
  );
}

export function memberDetailPage(skin: Skin, m: {
  id: string;
  name: string;
  savings: string;
  checking: string;
}): string {
  return page(
    `Member ${m.id}`,
    `
    <table border="1" cellpadding="6">
      <tr><td>Member ID</td><td>${escapeHtml(m.id)}</td></tr>
      <tr><td>Name</td><td>${escapeHtml(m.name)}</td></tr>
      <tr><td>${escapeHtml(skin.savingsLabel)}</td><td>${m.savings}</td></tr>
      <tr><td>Checking Balance</td><td>${m.checking}</td></tr>
    </table>
    <br/>
    <a href="/members/${encodeURIComponent(m.id)}/new-subaccount">Open New Sub-Account</a>
    &nbsp;|&nbsp;
    <a href="/members/search">Back to Search</a>
  `
  );
}

export function newSubAccountFormPage(memberId: string, error?: string): string {
  return page(
    "Open New Sub-Account",
    `
    ${error ? `<table bgcolor="#ffdddd"><tr><td><b>${escapeHtml(error)}</b></td></tr></table><br/>` : ""}
    <form method="POST" action="/members/${encodeURIComponent(memberId)}/new-subaccount">
      <table border="0" cellpadding="4">
        <tr><td>Account Type</td><td>
          <select name="accountType">
            <option value="SAVINGS_SUB">Savings Sub-Account</option>
            <option value="CHRISTMAS_CLUB">Christmas Club</option>
          </select>
        </td></tr>
        <tr><td>Initial Deposit (USD)</td><td><input type="text" name="initialDeposit"/></td></tr>
        <tr><td colspan="2"><input type="submit" value="Continue"/></td></tr>
      </table>
    </form>
    <br/><a href="/members/${encodeURIComponent(memberId)}">Cancel, back to member</a>
  `
  );
}

export function supervisorOverridePage(memberId: string, initialDeposit: string, error?: string): string {
  return page(
    "Supervisor Override Required",
    `
    <table bgcolor="#fff3cd" border="1" cellpadding="6"><tr><td>
      <b>Supervisor override required:</b> opening deposits of $10,000.00 or more need a supervisor's approval (BSA policy 4.2).
    </td></tr></table>
    <br/>
    ${error ? `<table bgcolor="#ffdddd"><tr><td><b>${escapeHtml(error)}</b></td></tr></table><br/>` : ""}
    <table border="1" cellpadding="6">
      <tr><td>Member ID</td><td>${escapeHtml(memberId)}</td></tr>
      <tr><td>Initial Deposit</td><td>${escapeHtml(initialDeposit)}</td></tr>
    </table>
    <br/>
    <form method="POST" action="/members/${encodeURIComponent(memberId)}/new-subaccount/override">
      <table border="0" cellpadding="4">
        <tr><td>Supervisor PIN</td><td><input type="password" name="supervisorPin" autocomplete="off"/></td></tr>
        <tr><td colspan="2"><input type="submit" value="Approve Override"/></td></tr>
      </table>
    </form>
    <a href="/members/${encodeURIComponent(memberId)}">Cancel</a>
  `
  );
}

export function confirmSubAccountPage(args: {
  memberId: string;
  accountType: string;
  initialDeposit: string;
  token: string;
}): string {
  return page(
    "Confirm New Sub-Account",
    `
    <table bgcolor="#fff3cd" border="1" cellpadding="6"><tr><td>
      This action opens a new account and cannot be undone from this screen. Review carefully.
    </td></tr></table>
    <br/>
    <table border="1" cellpadding="6">
      <tr><td>Member ID</td><td>${escapeHtml(args.memberId)}</td></tr>
      <tr><td>Account Type</td><td>${escapeHtml(args.accountType)}</td></tr>
      <tr><td>Initial Deposit</td><td>${escapeHtml(args.initialDeposit)}</td></tr>
    </table>
    <br/>
    <form method="POST" action="/members/${encodeURIComponent(args.memberId)}/new-subaccount/confirm">
      <input type="hidden" name="token" value="${escapeHtml(args.token)}"/>
      <input type="hidden" name="accountType" value="${escapeHtml(args.accountType)}"/>
      <input type="hidden" name="initialDeposit" value="${escapeHtml(args.initialDeposit)}"/>
      <input type="submit" value="Confirm and Open Account"/>
    </form>
    <a href="/members/${encodeURIComponent(args.memberId)}">Cancel</a>
  `
  );
}

export function subAccountSuccessPage(args: { memberId: string; accountNumber: string }): string {
  return page(
    "Sub-Account Opened",
    `
    <table bgcolor="#ddffdd" border="1" cellpadding="6"><tr><td>
      <b>Sub-account opened for member ${escapeHtml(args.memberId)}.</b>
    </td></tr></table>
    <br/>
    <table border="1" cellpadding="6">
      <tr><td>New Account Number</td><td>${escapeHtml(args.accountNumber)}</td></tr>
      <tr><td>Member ID</td><td>${escapeHtml(args.memberId)}</td></tr>
    </table>
    <br/><a href="/members/${encodeURIComponent(args.memberId)}">Back to member</a>
  `
  );
}

export function sessionExpiredPage(): string {
  return page(
    "Session Expired",
    `
    <table bgcolor="#ffdddd" border="1" cellpadding="6"><tr><td>
      <b>Your session has expired. Please sign in again.</b>
    </td></tr></table>
    <br/><a href="/login">Go to Login</a>
  `
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
