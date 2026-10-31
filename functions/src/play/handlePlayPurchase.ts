import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {PlayApiError, type PlayClient, type PlayLineItem, type PlaySubscription} from "./playClient";
import {
  PLAY_CONFIG_PATH,
  PLAY_PURCHASES,
  PLAY_REQUESTS,
  PLAY_SECRETS,
  POLL_INTERVAL_MS,
  decideEntitlement,
  errorText,
  hashableToken,
  normalizePlayState,
  parsePurchaseRequest,
  purchaseTokenHash,
  type PlayConfig,
  type SubscriptionState,
  type UserClock,
} from "./subscription";

export async function loadPlayConfig(db: Firestore): Promise<PlayConfig> {
  const snap = await db.doc(PLAY_CONFIG_PATH).get();
  const data = snap.data() ?? {};
  const rawIds: unknown = data.productIds;
  const productIds = Array.isArray(rawIds) ?
    rawIds.filter((id): id is string => typeof id === "string" && id.length > 0) :
    [];
  const packageName = data.packageName;
  return {
    enabled: data.enabled === true,
    packageName: typeof packageName === "string" ? packageName : "",
    productIds,
  };
}

export function matchingLine(sub: PlaySubscription, productId: string): PlayLineItem | null {
  let best: PlayLineItem | null = null;
  for (const item of sub.lineItems) {
    if (item.productId !== productId) continue;
    if (!best || item.expiryTimeMs > best.expiryTimeMs) best = item;
  }
  return best;
}

function readClock(snap: DocumentSnapshot): UserClock {
  const expires = snap.get("subscriptionExpiresAt");
  const source = snap.get("subscriptionSource");
  const tokenHash = snap.get("playPurchaseTokenHash");
  return {
    expiresAtMs: expires instanceof Timestamp ? expires.toMillis() : null,
    source: typeof source === "string" ? source : null,
    tokenHash: typeof tokenHash === "string" ? tokenHash : null,
  };
}

function errorFields(code: string, hash: string | null): Record<string, unknown> {
  const update: Record<string, unknown> = {
    status: "error",
    error: errorText(code),
    errorCode: code,
    purchaseToken: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (hash) update.purchaseTokenHash = hash;
  return update;
}

async function finishError(
  db: Firestore,
  requestId: string,
  code: string,
  hash: string | null,
): Promise<void> {
  const ref = db.collection(PLAY_REQUESTS).doc(requestId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") !== "pending") return;
    tx.update(ref, errorFields(code, hash));
  });
}

interface CommitInput {
  db: Firestore;
  requestId: string | null;
  uid: string;
  token: string;
  hash: string;
  packageName: string;
  productId: string;
  state: SubscriptionState;
  expiryMs: number;
  acknowledgement: "pending" | "acknowledged";
  latestOrderId?: string;
  linkedTokenHash?: string;
  testPurchase: boolean;
  nowMs: number;
}

// Writes the ledger, the sealed token, the Gold clock, and the request result.
// The raw token is stored only on playPurchaseSecrets, which rules deny.
export async function commitPurchase(input: CommitInput): Promise<void> {
  const requestRef = input.requestId ?
    input.db.collection(PLAY_REQUESTS).doc(input.requestId) :
    null;
  const ledgerRef = input.db.collection(PLAY_PURCHASES).doc(input.hash);
  const secretRef = input.db.collection(PLAY_SECRETS).doc(input.hash);
  const linkedRef = input.linkedTokenHash && input.linkedTokenHash !== input.hash ?
    input.db.collection(PLAY_PURCHASES).doc(input.linkedTokenHash) :
    null;
  const userRef = input.db.collection("users").doc(input.uid);

  await input.db.runTransaction(async (tx) => {
    const requestSnap = requestRef ? await tx.get(requestRef) : null;
    const ledgerSnap = await tx.get(ledgerRef);
    const linkedSnap = linkedRef ? await tx.get(linkedRef) : null;
    const secretSnap = await tx.get(secretRef);
    const userSnap = await tx.get(userRef);

    if (requestSnap && requestSnap.get("status") !== "pending") return;

    const ledgerUid = ledgerSnap.get("uid");
    const linkedUid = linkedSnap?.get("uid");
    const blocked =
      (typeof ledgerUid === "string" && ledgerUid !== input.uid) ||
      (typeof linkedUid === "string" && linkedUid !== input.uid);
    if (blocked) {
      if (requestRef) tx.update(requestRef, errorFields("already-linked", input.hash));
      return;
    }

    const decision = decideEntitlement({
      nowMs: input.nowMs,
      state: input.state,
      expiryMs: input.expiryMs,
      tokenHash: input.hash,
      productId: input.productId,
      user: readClock(userSnap),
    });

    const ledger: Record<string, unknown> = {
      v: 1,
      uid: input.uid,
      productId: input.productId,
      packageName: input.packageName,
      expiresAt: Timestamp.fromMillis(input.expiryMs),
      subscriptionState: input.state,
      acknowledgementState: input.acknowledgement,
      testPurchase: input.testPurchase,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (input.latestOrderId) ledger.latestOrderId = input.latestOrderId;
    if (input.linkedTokenHash) ledger.linkedTokenHash = input.linkedTokenHash;
    if (!ledgerSnap.exists) ledger.createdAt = FieldValue.serverTimestamp();
    ledger.nextCheckAt = decision.poll ?
      Timestamp.fromMillis(input.nowMs + POLL_INTERVAL_MS) :
      FieldValue.delete();
    tx.set(ledgerRef, ledger, {merge: true});

    if (decision.poll) {
      tx.set(secretRef, {
        purchaseToken: input.token,
        uid: input.uid,
        packageName: input.packageName,
        productId: input.productId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (secretSnap.exists) {
      tx.delete(secretRef);
    }

    if (decision.user) {
      const patch: Record<string, unknown> = {
        subscriptionExpiresAt: Timestamp.fromMillis(decision.user.subscriptionExpiresAtMs),
      };
      if (decision.user.subscriptionSource) {
        patch.subscriptionSource = decision.user.subscriptionSource;
      }
      if (decision.user.playPurchaseTokenHash) {
        patch.playPurchaseTokenHash = decision.user.playPurchaseTokenHash;
      }
      if (decision.user.subscriptionProductId) {
        patch.subscriptionProductId = decision.user.subscriptionProductId;
      }
      tx.set(userRef, patch, {merge: true});
    }

    if (requestRef) {
      const update: Record<string, unknown> = {
        status: decision.status,
        purchaseTokenHash: input.hash,
        subscriptionState: input.state,
        purchaseToken: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (decision.expiresAtMs != null) {
        update.expiresAt = Timestamp.fromMillis(decision.expiresAtMs);
      }
      if (decision.status === "error" && decision.error && decision.errorCode) {
        update.error = decision.error;
        update.errorCode = decision.errorCode;
      }
      tx.update(requestRef, update);
    }
  });
}

function linkedHashOf(sub: PlaySubscription): string | undefined {
  if (!sub.linkedPurchaseToken) return undefined;
  return purchaseTokenHash(sub.linkedPurchaseToken);
}

async function verifyRequest(
  db: Firestore,
  requestId: string,
  raw: Record<string, unknown>,
  client: PlayClient,
  now: Date,
): Promise<void> {
  const status = raw.status;
  if (status === "done" || status === "error") return;

  const token = hashableToken(raw);
  const hash = token ? purchaseTokenHash(token) : null;
  const parsed = parsePurchaseRequest(raw);
  if (!parsed || !token || !hash) {
    await finishError(db, requestId, "invalid-payload", hash);
    return;
  }

  const config = await loadPlayConfig(db);
  if (!config.enabled) {
    logger.info("play purchase flag off", {requestId});
    await finishError(db, requestId, "flag-off", hash);
    return;
  }
  if (!config.packageName || config.productIds.length === 0) {
    await finishError(db, requestId, "failed-precondition", hash);
    return;
  }
  if (parsed.packageName !== config.packageName) {
    await finishError(db, requestId, "package-mismatch", hash);
    return;
  }
  if (!config.productIds.includes(parsed.productId)) {
    await finishError(db, requestId, "product-mismatch", hash);
    return;
  }

  const existing = await db.collection(PLAY_PURCHASES).doc(hash).get();
  const owner = existing.get("uid");
  if (typeof owner === "string" && owner !== parsed.uid) {
    await finishError(db, requestId, "already-linked", hash);
    return;
  }

  let sub: PlaySubscription;
  try {
    sub = await client.getSubscription(parsed.packageName, parsed.purchaseToken);
  } catch (err) {
    const code = err instanceof PlayApiError ? err.code : "internal";
    await finishError(db, requestId, code, hash);
    return;
  }

  const line = matchingLine(sub, parsed.productId);
  if (!line) {
    await finishError(db, requestId, "product-mismatch", hash);
    return;
  }

  const state = normalizePlayState(sub.subscriptionState);
  let acknowledgement: "pending" | "acknowledged" =
    sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" ? "acknowledged" : "pending";
  if (acknowledgement === "pending" && state !== "pending") {
    try {
      await client.acknowledge(parsed.packageName, parsed.productId, parsed.purchaseToken);
      acknowledgement = "acknowledged";
    } catch (err) {
      const retryable = err instanceof PlayApiError && err.code === "unavailable";
      if (!retryable) {
        const code = err instanceof PlayApiError ? err.code : "internal";
        await finishError(db, requestId, code, hash);
        return;
      }
    }
  }

  await commitPurchase({
    db,
    requestId,
    uid: parsed.uid,
    token: parsed.purchaseToken,
    hash,
    packageName: parsed.packageName,
    productId: parsed.productId,
    state,
    expiryMs: line.expiryTimeMs,
    acknowledgement,
    latestOrderId: sub.latestOrderId,
    linkedTokenHash: linkedHashOf(sub),
    testPurchase: sub.testPurchase,
    nowMs: now.getTime(),
  });
  logger.info("play purchase finished", {requestId, hashPrefix: hash.slice(0, 8), state});
}

// Verifies one playPurchaseRequests create. Terminal requests are left as
// they are. While the flag is off, the user document is not written.
export async function handlePlayPurchaseRequest(
  db: Firestore,
  requestId: string,
  raw: Record<string, unknown>,
  client: PlayClient,
  now: Date = new Date(),
): Promise<void> {
  try {
    await verifyRequest(db, requestId, raw, client, now);
  } catch (err) {
    const code = err instanceof PlayApiError ? err.code : "internal";
    logger.error("play purchase failed", {requestId, code});
    const token = hashableToken(raw);
    await finishError(db, requestId, code, token ? purchaseTokenHash(token) : null);
  }
}
