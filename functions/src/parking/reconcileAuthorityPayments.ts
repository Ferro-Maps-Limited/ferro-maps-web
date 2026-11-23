import * as logger from "firebase-functions/logger";
import {onSchedule} from "firebase-functions/v2/scheduler";
import {Firestore, getFirestore} from "firebase-admin/firestore";
import {
  drainAuthorityQueue,
  resumeIfIdle,
} from "./authorityJobs";
import {
  expireDueAuthorityJobs,
  requeueStuckNotices,
  retryPendingJobs,
} from "./authorityDesk";
import {refundStripe} from "./stripeAdapter";
import {ensureFerroStripeAccount, openStripeClient, stripeSecretKey} from "./stripeClient";

export async function reconcileAuthorityPaymentsOnce(
  db: Firestore,
  refunds: ReturnType<typeof refundStripe>,
  nowMs = Date.now(),
): Promise<void> {
  await retryPendingJobs(db, nowMs);
  await expireDueAuthorityJobs(db, refunds, nowMs);
  await drainAuthorityQueue(db, nowMs);
  await resumeIfIdle(db, nowMs);
  await requeueStuckNotices(db, nowMs);
}

// Queued jobs are refunded at the authority deadline minus three hours, or
// 24 hours after they were queued, whichever is first. A top-up also drains
// the queue; this pass covers the deadline and a London-day cap reset.
export const reconcileAuthorityPayments = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "Europe/London",
    region: "europe-west2",
    secrets: [stripeSecretKey],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    try {
      const db = getFirestore();
      const raw = await openStripeClient(db, stripeSecretKey.value());
      await ensureFerroStripeAccount(() => raw.accounts.retrieve(null));
      await reconcileAuthorityPaymentsOnce(db, refundStripe(raw), Date.now());
    } catch (err) {
      logger.error("reconcileAuthorityPayments failed", {
        name: err instanceof Error ? err.name : "unknown",
      });
      throw err;
    }
  },
);
