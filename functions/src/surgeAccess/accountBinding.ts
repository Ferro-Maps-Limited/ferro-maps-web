import {randomUUID} from "node:crypto";
import {FieldValue, type Firestore, type Transaction} from "firebase-admin/firestore";
import {REQUEST_ADMISSION, SurgeAccessError, assertUid, isUuid} from "./contract.js";
import {ADMISSION} from "./iapRequest.js";

export const ACCOUNT_REQUESTS = "surgeAccountRequests";
export const BILLING_ACCOUNTS = "surgeBillingAccounts";
export const ACCOUNT_TOKENS = "surgeAccountTokens";
export const PLAY_IDS = "surgePlayAccountIds";

export interface AccountBinding {
  uid: string;
  appAccountToken: string;
  playObfuscatedId: string;
  created: boolean;
}

export interface BindingIds {
  appAccountToken: string;
  playObfuscatedId: string;
}

function freshIds(): BindingIds {
  return {appAccountToken: randomUUID(), playObfuscatedId: randomUUID()};
}

function assertIssuedIds(uid: string, ids: BindingIds): void {
  if (!isUuid(ids.appAccountToken) || !isUuid(ids.playObfuscatedId)) {
    throw new SurgeAccessError("bad-binding-id");
  }
  if (ids.appAccountToken === ids.playObfuscatedId) throw new SurgeAccessError("binding-ids-must-differ");
  if (ids.appAccountToken === uid || ids.playObfuscatedId === uid) {
    throw new SurgeAccessError("binding-id-must-not-be-uid");
  }
}

function readBinding(uid: string, data: Record<string, unknown> | undefined): AccountBinding {
  const appAccountToken = data?.appAccountToken;
  const playObfuscatedId = data?.playObfuscatedId;
  if (typeof appAccountToken !== "string" || typeof playObfuscatedId !== "string") {
    throw new SurgeAccessError("binding-corrupt");
  }
  assertIssuedIds(uid, {appAccountToken, playObfuscatedId});
  return {uid, appAccountToken, playObfuscatedId, created: false};
}

/*
 * One stable pair per Firebase Auth uid. A retry returns the same pair.
 * The app cannot choose either value. appAccountToken is an account binding,
 * not a login.
 */
export async function issueSurgeAccountBinding(
  db: Firestore,
  uid: string,
  mint: () => BindingIds = freshIds,
): Promise<AccountBinding> {
  assertUid(uid);
  return db.runTransaction(async (tx) => allocate(db, tx, uid, mint));
}

async function allocate(
  db: Firestore,
  tx: Transaction,
  uid: string,
  mint: () => BindingIds,
): Promise<AccountBinding> {
  const accountRef = db.collection(BILLING_ACCOUNTS).doc(uid);
  const existing = await tx.get(accountRef);
  if (existing.exists) return readBinding(uid, existing.data() as Record<string, unknown> | undefined);
  const ids = mint();
  assertIssuedIds(uid, ids);
  const tokenRef = db.collection(ACCOUNT_TOKENS).doc(ids.appAccountToken);
  const playRef = db.collection(PLAY_IDS).doc(ids.playObfuscatedId);
  const tokenSnap = await tx.get(tokenRef);
  const playSnap = await tx.get(playRef);
  if (tokenSnap.exists || playSnap.exists) throw new SurgeAccessError("binding-collision");
  tx.set(accountRef, {
    v: 1,
    uid,
    appAccountToken: ids.appAccountToken,
    playObfuscatedId: ids.playObfuscatedId,
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.set(tokenRef, {v: 1, uid});
  tx.set(playRef, {v: 1, uid});
  return {uid, appAccountToken: ids.appAccountToken, playObfuscatedId: ids.playObfuscatedId, created: true};
}

function openAccount(data: Record<string, unknown> | undefined): number {
  if (data == null || data.openAccount == null) return 0;
  const value = data.openAccount;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SurgeAccessError("admission-corrupt");
  }
  return value;
}

/*
 * Opens one account-binding request for this uid. Not a Cloud Function.
 * A stored request is trusted over any caller-supplied token. The cap does
 * not grant surge opens and does not reset when the plan changes.
 */
export async function fulfillSurgeAccountRequest(
  db: Firestore,
  requestId: string,
  authUid: string,
): Promise<AccountBinding> {
  if (!isUuid(requestId)) throw new SurgeAccessError("bad-request-id");
  assertUid(authUid);
  return db.runTransaction(async (tx) => {
    const ref = db.collection(ACCOUNT_REQUESTS).doc(requestId);
    const admissionRef = db.collection(ADMISSION).doc(authUid);
    const snap = await tx.get(ref);
    const admission = await tx.get(admissionRef);
    const count = openAccount(admission.data() as Record<string, unknown> | undefined);
    if (snap.exists) {
      const body = snap.data() as Record<string, unknown>;
      if (body.v !== 1) throw new SurgeAccessError("bad-version");
      if (body.uid !== authUid) throw new SurgeAccessError("owner-mismatch");
      const binding = await allocate(db, tx, authUid, freshIds);
      tx.set(ref, {
        status: "issued",
        appAccountToken: binding.appAccountToken,
        playObfuscatedId: binding.playObfuscatedId,
      }, {merge: true});
      return binding;
    }
    if (count >= REQUEST_ADMISSION.maxOpenPerUid) throw new SurgeAccessError("admission-full");
    const binding = await allocate(db, tx, authUid, freshIds);
    tx.set(ref, {
      v: 1,
      uid: authUid,
      createdAt: FieldValue.serverTimestamp(),
      status: "issued",
      appAccountToken: binding.appAccountToken,
      playObfuscatedId: binding.playObfuscatedId,
    });
    tx.set(admissionRef, {uid: authUid, openAccount: count + 1}, {merge: true});
    return binding;
  });
}
