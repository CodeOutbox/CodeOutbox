// Coming back after unsubscribing. An unsubscribe writes an account-wide suppression
// with reason 'unsubscribe'; bounces and complaints write 'bounce' / 'complaint'.
//
// Someone who unsubscribed may sign up again through a form: they get a fresh opt-in
// email, and only confirming it (a new, explicit yes) lifts the 'unsubscribe'
// suppression. Bounced or complained addresses are never mailed again.

import { query, queryOne } from "./db";

// Suppressed for a reason we must keep honouring (bounce, complaint, …).
export async function hardSuppressed(accountId: number | null, email: string): Promise<boolean> {
  if (!accountId) return false;
  const row = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM suppressions
      WHERE account_id = $1 AND email = $2 AND reason IS DISTINCT FROM 'unsubscribe'`,
    [accountId, email],
  );
  return !!row;
}

// After a confirmed opt-in: drop the account's 'unsubscribe' suppression for this
// address. Other lists the person left keep status 'unsubscribed', so they stay off.
export async function liftUnsubscribe(accountId: number | null, email: string): Promise<void> {
  if (!accountId) return;
  await query(
    `DELETE FROM suppressions WHERE account_id = $1 AND email = $2 AND reason = 'unsubscribe'`,
    [accountId, email],
  );
}
