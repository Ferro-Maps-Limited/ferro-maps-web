import {FieldValue, Timestamp, getFirestore, type Firestore} from "firebase-admin/firestore";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {PlayApiError, createPlayClient, type PlayClient} from "./playClient";
import {
  commitPurchase,
  loadPlayConfig,
  matchingLine,
} from "./handlePlayPurchase";
import {
  PLAY_CURSOR,
  PLAY_PURCHASES,
  PLAY_SECRETS,
  POLL_INTERVAL_MS,
  RECONCILE_BATCH,
  VOIDED_MAX_LOOKBACK_MS,
  VOIDED_OVERLAP_MS,
  normalizePlayState,
  purchaseTokenHash,
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
    if (err instanceof PlayApiError && err.code === "not-found") {
      await commitPurchase({
        db,
        requestId: null,
        uid,
        token,
        hash,
        packageName,
        productId,
        state: "refunded",
        expiryMs: now.getTime(),
        acknowledgement: "acknowledged",
        testPurchase: false,
        nowMs: now.getTime(),
      });
      return;
    }
    logger.error("play reconcile read failed", {
      hashPrefix: hash.slice(0, 8),
      code: err instanceof PlayApiError ? err.code : "internal",
    });
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
  const due = await db.collection(PLAY_PURCHASES)
    .where("nextCheckAt", "<=", Timestamp.fromDate(now))
    .orderBy("nextCheckAt", "asc")
    .limit(RECONCILE_BATCH)
    .get();

  for (const doc of due.docs) {
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
  const config = await loadPlayConfig(db);
  if (!config.enabled || config.packageName.length === 0) return;
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
