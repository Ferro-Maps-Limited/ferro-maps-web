export const DAILY_CAP_PENCE = 200_000;
export const LOW_WATER_PENCE = 10_000;
export const TOPUP_MAX_PENCE = 2_000_000;

export const LEDGER_KINDS = ["topup", "reserve", "commit", "release"] as const;
export type LedgerKind = typeof LEDGER_KINDS[number];

export interface FundingState {
  balancePence: number;
  reservedPence: number;
  spentTodayPence: number;
  spentDay: string;
  dailyCapPence: number;
  lowWaterPence: number;
  paused: boolean;
  lowWaterAlerted: boolean;
  lowWaterGeneration: number;
  pauseGeneration: number;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  amountPence: number;
  paymentIntentId?: string;
  requestId?: string;
}

export interface FundingAlert {
  id: string;
  kind: "low_water" | "paused" | "resumed";
  text: string;
}

export function initialFundingState(day: string): FundingState {
  return {
    balancePence: 0,
    reservedPence: 0,
    spentTodayPence: 0,
    spentDay: day,
    dailyCapPence: DAILY_CAP_PENCE,
    lowWaterPence: LOW_WATER_PENCE,
    paused: false,
    lowWaterAlerted: false,
    lowWaterGeneration: 0,
    pauseGeneration: 0,
  };
}

export function formatPence(pence: number): string {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}£${pounds}.${rest}`;
}

function nonNegative(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("funding amount is invalid");
  }
  return value;
}

function add(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("funding amount overflow");
  return sum;
}

export function spentOn(state: FundingState, day: string): number {
  return state.spentDay === day ? state.spentTodayPence : 0;
}

// Cash left after reservations, and room left under today's London cap.
export function availablePence(state: FundingState, day: string): number {
  const cash = state.balancePence - state.reservedPence;
  const room = state.dailyCapPence - spentOn(state, day);
  return Math.min(Math.max(cash, 0), Math.max(room, 0));
}

function rollover(state: FundingState, day: string): FundingState {
  if (state.spentDay === day) return {...state};
  return {...state, spentDay: day, spentTodayPence: 0};
}

export function applyLedger(state: FundingState, entry: LedgerEntry, day: string): FundingState {
  const next = rollover(state, day);
  const amount = entry.amountPence;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("bad ledger amount");
  if (entry.kind === "topup") {
    next.balancePence = add(next.balancePence, amount);
  } else if (entry.kind === "reserve") {
    if (amount > availablePence(next, day)) throw new Error("reserve exceeds available");
    next.reservedPence = add(next.reservedPence, amount);
  } else if (entry.kind === "commit") {
    if (amount > next.reservedPence) throw new Error("commit exceeds reserve");
    next.reservedPence -= amount;
    next.balancePence = nonNegative(next.balancePence - amount);
    next.spentTodayPence = add(next.spentTodayPence, amount);
  } else if (entry.kind === "release") {
    if (amount > next.reservedPence) throw new Error("release exceeds reserve");
    next.reservedPence -= amount;
  } else {
    throw new Error("bad ledger kind");
  }
  return next;
}

// Alert once each time available falls below the low-water mark, and clear
// the latch when it rises back to that mark or above.
export function withLowWater(baseline: FundingState, next: FundingState, day: string): FundingState {
  const available = availablePence(next, day);
  if (available < next.lowWaterPence) {
    if (!baseline.lowWaterAlerted) {
      return {...next, lowWaterAlerted: true, lowWaterGeneration: baseline.lowWaterGeneration + 1};
    }
    return {...next, lowWaterAlerted: true, lowWaterGeneration: baseline.lowWaterGeneration};
  }
  return {...next, lowWaterAlerted: false, lowWaterGeneration: baseline.lowWaterGeneration};
}

export function withPaused(state: FundingState, paused: boolean): FundingState {
  if (state.paused === paused) return state;
  return {...state, paused, pauseGeneration: state.pauseGeneration + 1};
}

export function fundingAlerts(before: FundingState, after: FundingState, day: string): FundingAlert[] {
  const alerts: FundingAlert[] = [];
  const available = formatPence(availablePence(after, day));
  if (after.lowWaterGeneration > before.lowWaterGeneration) {
    alerts.push({
      id: `funding:low_water:${after.lowWaterGeneration}`,
      kind: "low_water",
      text: `Available Ferro funding is ${available}, under £100. ` +
        "Top up the company funding card outside this system, then record the top-up in the admin payments desk.",
    });
  }
  if (!before.paused && after.paused) {
    alerts.push({
      id: `funding:paused:${after.pauseGeneration}`,
      kind: "paused",
      text: `Authority payments are paused. A job did not fit the available balance (${available}). ` +
        "New parking payments are refused until a top-up.",
    });
  }
  if (before.paused && !after.paused) {
    alerts.push({
      id: `funding:resumed:${after.pauseGeneration}`,
      kind: "resumed",
      text: `Authority payments resumed. Available balance is ${available}.`,
    });
  }
  return alerts;
}

function whole(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    return fallback;
  }
  return value;
}

export function fundingStateFromData(data: Record<string, unknown> | undefined, day: string): FundingState {
  if (!data) return initialFundingState(day);
  const balance = data.balancePence;
  const reserved = data.reservedPence;
  const spent = data.spentTodayPence;
  if (
    typeof balance !== "number" || !Number.isSafeInteger(balance) || balance < 0 ||
    typeof reserved !== "number" || !Number.isSafeInteger(reserved) || reserved < 0 ||
    typeof spent !== "number" || !Number.isSafeInteger(spent) || spent < 0
  ) {
    throw new Error("funding state is invalid");
  }
  const spentDay = typeof data.spentDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.spentDay) ?
    data.spentDay :
    day;
  const generation = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    balancePence: balance,
    reservedPence: reserved,
    spentTodayPence: spent,
    spentDay,
    dailyCapPence: whole(data.dailyCapPence, DAILY_CAP_PENCE, 10_000_000),
    lowWaterPence: whole(data.lowWaterPence, LOW_WATER_PENCE, 10_000_000),
    paused: data.paused === true,
    lowWaterAlerted: data.lowWaterAlerted === true,
    lowWaterGeneration: generation(data.lowWaterGeneration),
    pauseGeneration: generation(data.pauseGeneration),
  };
}

export function fundingStateToData(state: FundingState): Record<string, unknown> {
  return {
    balancePence: state.balancePence,
    reservedPence: state.reservedPence,
    spentTodayPence: state.spentTodayPence,
    spentDay: state.spentDay,
    dailyCapPence: state.dailyCapPence,
    lowWaterPence: state.lowWaterPence,
    paused: state.paused,
    lowWaterAlerted: state.lowWaterAlerted,
    lowWaterGeneration: state.lowWaterGeneration,
    pauseGeneration: state.pauseGeneration,
  };
}
