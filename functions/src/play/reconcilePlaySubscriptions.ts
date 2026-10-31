import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {PlayApiError, createPlayClient, type PlayClient} from "./playClient";
import {
  commitPurchase,
  handlePlayPurchaseRequest,
  loadPlayConfig,
  matchingLine,
} from "./handlePlayPurchase";
import {
  PLAY_CURSOR,
  PLAY_PURCHASES,
  PLAY_REQUESTS,
  PLAY_SECRETS,
  POLL_INTERVAL_MS,
  RECONCILE_BATCH,
  UNACKNOWLEDGED_REQUEST_MS,
  VOIDED_MAX_LOOKBACK_MS,
  VOIDED_OVERLAP_MS,
  errorText,
  hashableToken,
  normalizePlayState,
  purchaseTokenHash,
  uidAccountHash,
} from "./subscription";

async function refreshToken(
  db: Firestore,
  client: PlayClient,
  hash: string,
  token: string,
  now: Date,
): Promise<void> {
  const ledger = await db.collection(PLAY_PURCHASES).doc(hash).get();
  if (!ledger.exists) return;
  const uid = ledger.get("uid");
  const productId = ledger.get("productId");
  const packageName = ledger.get("packageName");
  if (typeof uid !== "string" || typeof productId !== "string" || typeof packageName !== "string") {
    return;
  }

  let sub;
  try {
    sub = await client.getSubscription(packageName, token);
  } catch (err) {
    // A failed read is not a downgrade. Gold stays until Play answers.
    logger.error("play reconcile read failed", {
      hashPrefix: hash.slice(0, 8),
      code: err instanceof PlayApiError ? err.code : "internal",
    });
    return;
  }

  const accountHash = uidAccountHash(uid);
  if ((sub.obfuscatedExternalAccountId ?? "").toLowerCase() !== accountHash) {
    logger.error("play reconcile account mismatch", {hashPrefix: hash.slice(0, 8)});
    return;
  }

  const line = matchingLine(sub, productId);
  if (!line) {
    logger.error("play reconcile product missing", {hashPrefix: hash.slice(0, 8)});
    return;
  }

  const state = normalizePlayState(sub.subscriptionState);
  let acknowledgement: "pending" | "acknowledged" =
    sub.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" ? "acknowledged" : "pending";
  if (acknowledgement === "pending" && state !== "pending") {
    try {
      await client.acknowledge(packageName, productId, token);
      acknowledgement = "acknowledged";
    } catch (err) {
      logger.error("play acknowledge retry failed", {
        hashPrefix: hash.slice(0, 8),
        code: err instanceof PlayApiError ? err.code : "internal",
      });
    }
  }

  const linked = sub.linkedPurchaseToken ? purchaseTokenHash(sub.linkedPurchaseToken) : undefined;
  await commitPurchase({
    db,
    requestId: null,
    uid,
    token,
    hash,
    packageName,
    productId,
    state,
    expiryMs: line.expiryTimeMs,
    acknowledgement,
    latestOrderId: sub.latestOrderId,
    linkedTokenHash: linked,
    testPurchase: sub.testPurchase,
    nowMs: now.getTime(),
  });
}

async function refreshDue(db: Firestore, client: PlayClient, now: Date): Promise<void> {
  const nowTs = Timestamp.fromDate(now);
  const [byCheck, byExpiry] = await Promise.all([
    db.collection(PLAY_PURCHASES)
      .where("nextCheckAt", "<=", nowTs)
      .orderBy("nextCheckAt", "asc")
      .limit(RECONCILE_BATCH)
      .get(),
    db.collection(PLAY_PURCHASES)
      .where("expiresAt", "<=", nowTs)
      .orderBy("expiresAt", "asc")
      .limit(RECONCILE_BATCH)
      .get(),
  ]);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const doc of [...byCheck.docs, ...byExpiry.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    ids.push(doc.id);
    if (ids.length >= RECONCILE_BATCH) break;
  }

  for (const id of ids) {
    const doc = await db.collection(PLAY_PURCHASES).doc(id).get();
    if (!doc.exists) continue;
    const secret = await db.collection(PLAY_SECRETS).doc(doc.id).get();
    const token = secret.get("purchaseToken");
    if (typeof token !== "string") {
      await doc.ref.set({
        nextCheckAt: Timestamp.fromMillis(now.getTime() + POLL_INTERVAL_MS),
        updatedAt: FieldValue.serverTimestamp(),
      }, {merge: true});
      continue;
    }
    await refreshToken(db, client, doc.id, token, now);
  }
}

async function dropUnacknowledged(db: Firestore, now: Date): Promise<void> {
  const cutoff = now.getTime() - UNACKNOWLEDGED_REQUEST_MS;
  const pending = await db.collection(PLAY_REQUESTS)
    .where("status", "==", "pending")
    .limit(100)
    .get();
  for (const doc of pending.docs) {
    const created = doc.get("createdAt");
    if (!(created instanceof Timestamp) || created.toMillis() > cutoff) continue;
    const raw = doc.data() as Record<string, unknown>;
    const token = hashableToken(raw);
    const hash = token ? purchaseTokenHash(token) : null;
    const dropped = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (fresh.get("status") !== "pending") return false;
      const update: Record<string, unknown> = {
        status: "error",
        error: errorText("ack-expired"),
        errorCode: "ack-expired",
        purchaseToken: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (hash) update.purchaseTokenHash = hash;
      tx.update(doc.ref, update);
      return true;
    });
    if (!dropped || !hash) continue;
    const ledger = await db.collection(PLAY_PURCHASES).doc(hash).get();
    if (!ledger.exists || ledger.get("acknowledgementState") !== "acknowledged") {
      await db.collection(PLAY_SECRETS).doc(hash).delete();
    }
  }
}

async function processPending(db: Firestore, client: PlayClient, now: Date): Promise<void> {
  const pending = await db.collection(PLAY_REQUESTS)
    .where("status", "==", "pending")
    .limit(20)
    .get();
  for (const doc of pending.docs) {
    const raw = doc.data() as Record<string, unknown>;
    await handlePlayPurchaseRequest(db, doc.id, raw, client, now);
  }
}

async function applyVoided(db: Firestore, client: PlayClient, packageName: string, now: Date): Promise<void> {
  const cursorRef = db.doc(PLAY_CURSOR);
  const cursor = await cursorRef.get();
  const stored = cursor.get("lastVoidedQueryMillis");
  const nowMs = now.getTime();
  const floor = nowMs - VOIDED_MAX_LOOKBACK_MS;
  let start = typeof stored === "number" ? stored - VOIDED_OVERLAP_MS : floor;
  if (start < floor) start = floor;

  const voided = await client.listVoided(packageName, start);
  for (const row of voided) {
    const hash = purchaseTokenHash(row.purchaseToken);
    const ledger = await db.collection(PLAY_PURCHASES).doc(hash).get();
    if (!ledger.exists) continue;
    const secret = await db.collection(PLAY_SECRETS).doc(hash).get();
    const storedToken = secret.get("purchaseToken");
    const token = typeof storedToken === "string" ? storedToken : row.purchaseToken;
    await refreshToken(db, client, hash, token, now);
  }

  await cursorRef.set({
    lastVoidedQueryMillis: nowMs,
    updatedAt: FieldValue.serverTimestamp(),
  }, {merge: true});
}

// Hourly poll of Play. RTDN is not used. Returns immediately while the flag
// is off, so an existing Gold clock is left alone.
export async function reconcilePlaySubscriptionsRun(
  db: Firestore,
  client: PlayClient,
  now: Date = new Date(),
): Promise<void> {
  await dropUnacknowledged(db, now);
  const config = await loadPlayConfig(db);
  if (!config.enabled || config.packageName.length === 0) return;
  await processPending(db, client, now);
  await refreshDue(db, client, now);
  await applyVoided(db, client, config.packageName, now);
}

export const reconcilePlaySubscriptions = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Europe/London",
    region: "europe-west2",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    await reconcilePlaySubscriptionsRun(getFirestore(), createPlayClient());
  },
);
