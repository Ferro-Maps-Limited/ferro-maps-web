import {Timestamp, type Firestore} from "firebase-admin/firestore";

export const SURGE_LEDGER = "surge_ledger";
export const SURGE_LEDGER_LOCK_ID = "lock";

/*
 * Server-only surge credits. One grant document is one credit. One spend
 * document is one credit. Nothing on the user document stores a running
 * total, and these documents are not readable by the phone.
 *
 * The spend document id is spend_ plus the unlock request id. Replaying that
 * request finds the same document and does not write another.
 *
 * A lock document, id "lock", is written only when a spend is written. It
 * holds no credit. Concurrent spends read it inside the transaction so two
 * requests cannot both take the last credit. It is not a total.
 *
 * grantSurgeCreditEntry is not a Cloud Function and not a callable. Tests and
 * a future admin tool call it with the Admin SDK. Purchases, a monthly
 * allowance, and tester grants are not written here.
 */

export function surgeSpendDocId(requestId: string): string {
  return `spend_${requestId}`;
}

export function availableSurgeCredits(entries: readonly {kind?: unknown}[]): number {
  let grants = 0;
  let spends = 0;
  for (const entry of entries) {
    if (entry.kind === "grant") grants += 1;
    else if (entry.kind === "spend") spends += 1;
  }
  const left = grants - spends;
  return left > 0 ? left : 0;
}

export function surgeGrantFields(now: Date): Record<string, unknown> {
  return {
    kind: "grant",
    source: "admin",
    createdAt: Timestamp.fromDate(now),
  };
}

export function surgeSpendFields(input: {
  requestId: string;
  hotspotId: string;
  summaryId: string;
  now: Date;
}): Record<string, unknown> {
  return {
    kind: "spend",
    requestId: input.requestId,
    hotspotId: input.hotspotId,
    summaryId: input.summaryId,
    createdAt: Timestamp.fromDate(input.now),
  };
}

function validLedgerId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("/");
}

/* One grant document. The same entry id does not grant a second credit. */
export async function grantSurgeCreditEntry(
  db: Firestore,
  uid: string,
  entryId: string,
  now: Date,
): Promise<void> {
  if (
    !validLedgerId(uid) ||
    !validLedgerId(entryId) ||
    entryId.startsWith("spend_") ||
    entryId === SURGE_LEDGER_LOCK_ID
  ) {
    throw new Error("invalid_grant");
  }
  const ref = db.collection("users").doc(uid).collection(SURGE_LEDGER).doc(entryId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return;
    tx.set(ref, surgeGrantFields(now));
  });
}
