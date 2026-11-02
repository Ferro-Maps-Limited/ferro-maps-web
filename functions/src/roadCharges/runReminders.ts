import {bankHolidayListMissing, isUnregisteredToken, MAX_DEVICE_TOKENS, MAX_SEND_ATTEMPTS} from "./config.js";
import {
  buildReminderMessage,
  classifyDue,
  isGoldAt,
  isReminderableRow,
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

export interface HistoryPayState {
  rowId: string;
  uid: string;
  paidAtMs: number | null;
  method: string | null;
  type: unknown;
  status: unknown;
  chargePence: unknown;
  travelDate: unknown;
  payByAt: unknown;
  lateDeadline: unknown;
}

export interface MalformedReminderLog {
  rowId: string;
  uid: string;
  reasons: string[];
}

export interface EntryOutcome {
  reminderState: "sent" | "due" | "failed" | "expired" | "skip";
  reminderReason: string;
  sendAttempts: number;
  reminderEligible: boolean;
  nextReminderSlot?: 1 | 2;
  nextReminderAt?: Date;
  reminder1SentAt?: Date;
  reminder2SentAt?: Date;
}

export interface ReminderDeps {
  now: Date;
  limit: number;
  newClaimId: () => string;
  loadHolidayLists: () => Promise<{cc: unknown; ulez: unknown}>;
  warn: (message: string, details?: MalformedReminderLog) => void;
  loadDue: (limit: number) => Promise<DueZoneEntry[]>;
  loadHistory: (entry: DueZoneEntry) => Promise<HistoryPayState>;
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
  skippedRun: boolean;
}

function emptySummary(): ReminderRunSummary {
  return {considered: 0, sent: 0, skipped: 0, failed: 0, expired: 0, tokensDeleted: 0, skippedRun: false};
}

const HOLIDAY_WARNING = "sendRoadChargeReminders skipped: bankHolidays is empty or missing";

// One page of due entries. Does not loop. A claimed entry is sent at most
// once: a throw before FCM accepts it is retried, a stuck claim is not.
export async function runReminders(deps: ReminderDeps): Promise<ReminderRunSummary> {
  const summary = emptySummary();
  const holidays = await deps.loadHolidayLists();
  if (bankHolidayListMissing(holidays.cc) || bankHolidayListMissing(holidays.ulez)) {
    deps.warn(HOLIDAY_WARNING);
    summary.skippedRun = true;
    return summary;
  }
  const due = await deps.loadDue(deps.limit);
  summary.considered = due.length;
  const warnedMalformed = new Set<string>();
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
        reminderEligible: true,
      });
      summary.skipped += 1;
      continue;
    }
    if (verdict === "expired") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "expired",
        reminderReason: "deadline-passed",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.expired += 1;
      continue;
    }
    if (verdict === "bad") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "bad-entry",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.failed += 1;
      continue;
    }
    const history = await deps.loadHistory(entry);
    const rowCheck = isReminderableRow({
      id: history.rowId,
      type: history.type,
      status: history.status,
      chargePence: history.chargePence,
      travelDate: history.travelDate,
      payByAt: history.payByAt != null ? history.payByAt : entry.payByAt,
      lateDeadline: history.lateDeadline,
      method: history.method,
    });
    if (rowCheck.reasons.length > 0) {
      if (!warnedMalformed.has(history.rowId)) {
        warnedMalformed.add(history.rowId);
        deps.warn("road_charge_reminder_skipped_malformed", {
          rowId: history.rowId,
          uid: history.uid,
          reasons: rowCheck.reasons,
        });
      }
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: "malformed",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.skipped += 1;
      continue;
    }
    if (history.paidAtMs != null) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: "paid",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.skipped += 1;
      continue;
    }
    if (history.method === "autopay" || history.method === "exempt") {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: history.method === "exempt" ? "exempt" : "autopay",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.skipped += 1;
      continue;
    }
    if (!rowCheck.remind) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: "no-charge",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
      });
      summary.skipped += 1;
      continue;
    }
    const user = await deps.loadUser(entry.uid);
    if (!isGoldAt(user.subscriptionExpiresAtMs, deps.now)) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "skip",
        reminderReason: "not-gold",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
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
        reminderEligible: false,
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
      if (entry.nextReminderSlot === 1) {
        await deps.writeEntry(entry.uid, entry.entryId, {
          reminderState: "due",
          reminderReason: "reminder-1-sent",
          sendAttempts: 0,
          reminderEligible: true,
          nextReminderSlot: 2,
          nextReminderAt: entry.reminder2At,
          reminder1SentAt: deps.now,
        });
      } else {
        await deps.writeEntry(entry.uid, entry.entryId, {
          reminderState: "sent",
          reminderReason: "sent",
          sendAttempts: entry.sendAttempts,
          reminderEligible: false,
          reminder2SentAt: deps.now,
        });
      }
      summary.sent += 1;
      continue;
    }
    if (!anyRetryable) {
      await deps.writeEntry(entry.uid, entry.entryId, {
        reminderState: "failed",
        reminderReason: "no-token",
        sendAttempts: entry.sendAttempts,
        reminderEligible: false,
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
        reminderEligible: false,
      });
      summary.failed += 1;
      continue;
    }
    await deps.writeEntry(entry.uid, entry.entryId, {
      reminderState: "due",
      reminderReason: "retry",
      sendAttempts: attempts,
      reminderEligible: true,
    });
    summary.failed += 1;
  }
  return summary;
}
