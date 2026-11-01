import {isUnregisteredToken, MAX_DEVICE_TOKENS, MAX_SEND_ATTEMPTS} from "./config.js";
import {
  buildReminderMessage,
  classifyDue,
  isGoldAt,
  resolveTokens,
  type DeviceToken,
  type DueZoneEntry,
  type ReminderMessage,
} from "./plan.js";

export interface UserPushState {
  subscriptionExpiresAtMs: number | null;
  legacyFcmToken: string | null;
}

export interface SendOutcome {
  ok: boolean;
  errorCode?: string;
}

export interface EntryOutcome {
  reminderState: "sent" | "due" | "failed" | "expired" | "skip";
  reminderReason: string;
  sendAttempts: number;
  reminderSentAt?: Date;
}

export interface ReminderDeps {
  now: Date;
  limit: number;
  newClaimId: () => string;
  loadDue: (limit: number) => Promise<DueZoneEntry[]>;
  /** Returns false when another run already moved the entry off `due`. */
  claim: (entry: DueZoneEntry, claimId: string) => Promise<boolean>;
  loadUser: (uid: string) => Promise<UserPushState>;
  loadTokens: (uid: string) => Promise<DeviceToken[]>;
  send: (messages: ReminderMessage[]) => Promise<SendOutcome[]>;
  writeEntry: (uid: string, entryId: string, patch: EntryOutcome) => Promise<void>;
  deleteToken: (uid: string, deviceId: string) => Promise<void>;
  /** Deletes `users/{uid}.fcmToken` only when it still equals `token`. */
  clearLegacyToken: (uid: string, token: string) => Promise<void>;
}

export interface ReminderRunSummary {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  expired: number;
  tokensDeleted: number;
}

function emptySummary(): ReminderRunSummary {
  return {considered: 0, sent: 0, skipped: 0, failed: 0, expired: 0, tokensDeleted: 0};
}

// One page of due entries. Does not loop. A claimed entry is sent at most
// once: a throw before FCM accepts it is retried, a stuck claim is not.
export async function runReminders(deps: ReminderDeps): Promise<ReminderRunSummary> {
  const summary = emptySummary();
  const due = await deps.loadDue(deps.limit);
  summary.considered = due.length;
  for (const entry of due) {
    const verdict = classifyDue(entry, deps.now);
    const claimId = deps.newClaimId();
    const claimed = await deps.claim(entry, claimId);
    if (!claimed) {
      summary.skipped += 1;
      continue;
    }
    if (verdict === "wait") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "due",
        reminderReason: "not-yet",
        sendAttempts: entry.sendAttempts,
      });
      summary.skipped += 1;
      continue;
    }
    if (verdict === "expired") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "expired",
        reminderReason: "deadline-passed",
        sendAttempts: entry.sendAttempts,
      });
      summary.expired += 1;
      continue;
    }
    if (verdict === "bad") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "bad-entry",
        sendAttempts: entry.sendAttempts,
      });
      summary.failed += 1;
      continue;
    }
    const user = await deps.loadUser(entry.uid);
    if (!isGoldAt(user.subscriptionExpiresAtMs, deps.now)) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: "not-gold",
        sendAttempts: entry.sendAttempts,
      });
      summary.skipped += 1;
      continue;
    }
    const tokens = resolveTokens(await deps.loadTokens(entry.uid), user.legacyFcmToken, MAX_DEVICE_TOKENS);
    if (tokens.length === 0) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "no-token",
        sendAttempts: entry.sendAttempts,
      });
      summary.failed += 1;
      continue;
    }
    const messages = tokens.map((token) => buildReminderMessage(entry, token.token));
    let results: SendOutcome[];
    try {
      results = await deps.send(messages);
    } catch {
      results = messages.map(() => ({ok: false, errorCode: "unavailable"}));
    }
    if (results.length !== messages.length) {
      results = messages.map((_, index) => results[index] ?? {ok: false, errorCode: "unavailable"});
    }
    let anyOk = false;
    let anyRetryable = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const result = results[index];
      if (result.ok) {
        anyOk = true;
        continue;
      }
      if (isUnregisteredToken(result.errorCode)) {
        const token = tokens[index];
        if (token.deviceId) {
          await deps.deleteToken(entry.uid, token.deviceId);
          summary.tokensDeleted += 1;
        }
        await deps.clearLegacyToken(entry.uid, token.token);
        continue;
      }
      anyRetryable = true;
    }
    if (anyOk) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "sent",
        reminderReason: "sent",
        sendAttempts: entry.sendAttempts,
        reminderSentAt: deps.now,
      });
      summary.sent += 1;
      continue;
    }
    if (!anyRetryable) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "no-token",
        sendAttempts: entry.sendAttempts,
      });
      summary.failed += 1;
      continue;
    }
    const attempts = entry.sendAttempts + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "send-failed",
        sendAttempts: attempts,
      });
      summary.failed += 1;
      continue;
    }
    await deps.writeEntry(entry.uid, entry.entryId, {
      reminderState: "due",
      reminderReason: "retry",
      sendAttempts: attempts,
    });
    summary.failed += 1;
  }
  return summary;
}
