export const JOB_STATUSES = [
  "queued",
  "open",
  "fulfilled",
  "failed",
  "already_paid",
  "expired",
] as const;

export type JobStatus = typeof JOB_STATUSES[number];

export const QUEUE_LIMIT_MS = 24 * 60 * 60 * 1000;
export const DEADLINE_LEAD_MS = 3 * 60 * 60 * 1000;

// Queued jobs can still be failed or marked already paid. A queued job is not
// fulfilled: the reserve has not happened, so ops must not record a payment
// the funding ledger does not cover. Open jobs are the ones on the desk.
const FORWARD: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["open", "expired", "failed", "already_paid"],
  open: ["fulfilled", "failed", "already_paid"],
  fulfilled: [],
  failed: [],
  already_paid: [],
  expired: [],
};

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

export function mergeJobStatus(current: string | undefined, incoming: JobStatus): JobStatus {
  if (!isJobStatus(current)) return incoming;
  if (current === incoming) return current;
  return FORWARD[current].includes(incoming) ? incoming : current;
}

// The earlier of the authority deadline minus three hours, and 24 hours after
// the job was queued. A deadline already inside the lead time is in the past,
// and the sweeper refunds on its next run.
export function refundAfterMillis(queuedAtMs: number, deadlineAtMs: number | null): number {
  const cap = queuedAtMs + QUEUE_LIMIT_MS;
  if (deadlineAtMs === null) return cap;
  return Math.min(cap, deadlineAtMs - DEADLINE_LEAD_MS);
}
