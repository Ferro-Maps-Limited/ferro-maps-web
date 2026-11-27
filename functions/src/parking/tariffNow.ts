import type {PlaceRates, RateSet} from "./privateSheet/types.js";

/*
 * What a stepped-price car park charges at one moment, in UK time.
 *
 * The apps run these same rules on a pin tap to show the price list and
 * decide on Pay now. The payment step runs them again on the server's clock,
 * and that is the price charged. The phone never sends a price.
 * test/fixtures/tariff-now-cases.json holds the shared cases; each app's copy
 * of these rules must pass them too.
 *
 * - charging: a paid set applies now. `options` are the stays on sale, each
 *   cut at the end of this charging time and at the maximum stay.
 * - free: a published free time applies now, or the free first band lasts
 *   until charging ends.
 * - outside: none of the published times applies now.
 * - unknown: a bank holiday the list says nothing about, two sets that
 *   disagree, or a day past the car park's bank holiday list. No Pay now.
 */

export const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;
const LOOK_DAYS = 8;

export interface Band {
  upTo: number;
  pence: number;
}

export interface StayOption {
  /* The band's own length. */
  upTo: number;
  /* What the driver gets: the band, cut at the end of charging time and the maximum stay. */
  minutes: number;
  pence: number;
}

export type UnknownReason = "bank-holiday" | "overlap" | "past-list";

export type TariffNow =
  | {
    state: "charging";
    set: RateSet;
    startsAtMs: number;
    endsAtMs: number;
    freeMinutes: number;
    options: StayOption[];
  }
  | {state: "free"; untilMs: number | null}
  | {state: "outside"; untilMs: number | null}
  | {state: "unknown"; reason: UnknownReason};

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export interface LondonMoment {
  /* YYYY-MM-DD */
  day: string;
  /* Minutes after midnight, 0 to 1439. */
  minute: number;
}

export function londonMoment(ms: number): LondonMoment {
  const parts: Record<string, string> = {};
  for (const part of LONDON.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/* 0 Monday … 6 Sunday. */
export function weekdayOf(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/* The instant the London clock reads `minute` on `day`. 1440 is the next midnight. */
export function londonInstant(day: string, minute: number): number {
  const whole = Math.floor(minute / DAY_MINUTES);
  if (whole > 0) return londonInstant(addDays(day, whole), minute - whole * DAY_MINUTES);
  const wall = Date.parse(`${day}T00:00:00Z`) + minute * MINUTE_MS;
  // Summer time first, so the repeated autumn hour gives its first instant.
  for (const offsetHours of [1, 0]) {
    const candidate = wall - offsetHours * 3_600_000;
    const at = londonMoment(candidate);
    if (at.day === day && at.minute === minute) return candidate;
  }
  // The clocks skip 1am to 2am in spring. A time inside that hour means 2am.
  return minute < 120 ? londonInstant(day, 120) : wall - 3_600_000;
}

export function bandsOf(set: RateSet): Band[] {
  const out: Band[] = [];
  for (let i = 0; i + 1 < set.b.length; i += 2) out.push({upTo: set.b[i], pence: set.b[i + 1]});
  return out;
}

function sameBands(a: RateSet, b: RateSet): boolean {
  return a.b.length === b.b.length && a.b.every((value, i) => value === b.b[i]);
}

function setsOn(rates: PlaceRates, day: string): RateSet[] | UnknownReason {
  if (day > rates.ht) return "past-list";
  if (rates.h.includes(day)) {
    const sets = rates.s.filter((set) => set.bh === 1);
    return sets.length > 0 ? sets : "bank-holiday";
  }
  const bit = 1 << weekdayOf(day);
  return rates.s.filter((set) => (set.d & bit) !== 0);
}

function activeAt(rates: PlaceRates, day: string, minute: number): {set: RateSet | null} | {unknown: UnknownReason} {
  const sets = setsOn(rates, day);
  if (typeof sets === "string") return {unknown: sets};
  const hits = sets.filter((set) => set.f <= minute && minute < set.t);
  if (hits.length === 0) return {set: null};
  if (hits.some((set) => !sameBands(set, hits[0]))) return {unknown: "overlap"};
  return {set: hits[0]};
}

/* Where this charging time ends: the same prices may run on past midnight. */
function runEnd(rates: PlaceRates, set: RateSet, day: string): number {
  let curDay = day;
  let minute = set.t;
  const last = addDays(day, LOOK_DAYS);
  while (curDay <= last) {
    const nextDay = minute >= DAY_MINUTES ? addDays(curDay, 1) : curDay;
    const nextMinute = minute >= DAY_MINUTES ? 0 : minute;
    const next = activeAt(rates, nextDay, nextMinute);
    if (!("set" in next) || next.set === null || !sameBands(next.set, set)) break;
    curDay = nextDay;
    minute = next.set.t;
  }
  return londonInstant(curDay, minute);
}

/* Where this charging time began. */
function runStart(rates: PlaceRates, set: RateSet, day: string): number {
  let curDay = day;
  let minute = set.f;
  const first = addDays(day, -LOOK_DAYS);
  while (curDay >= first) {
    const prevDay = minute === 0 ? addDays(curDay, -1) : curDay;
    const prevMinute = minute === 0 ? DAY_MINUTES - 1 : minute - 1;
    const prev = activeAt(rates, prevDay, prevMinute);
    if (!("set" in prev) || prev.set === null || !sameBands(prev.set, set)) break;
    curDay = prevDay;
    minute = prev.set.f;
  }
  return londonInstant(curDay, minute);
}

/* When charging next starts, from `fromMs`, within a week. Null when not known. */
function nextPaidStart(rates: PlaceRates, fromMs: number): number | null {
  const from = londonMoment(fromMs);
  for (let i = 0; i <= LOOK_DAYS; i += 1) {
    const day = addDays(from.day, i);
    const sets = setsOn(rates, day);
    if (typeof sets === "string") return null;
    const after = i === 0 ? from.minute : 0;
    let best: number | null = null;
    for (const set of sets) {
      if (!bandsOf(set).some((band) => band.pence >= 1) || set.t <= after) continue;
      const start = Math.max(set.f, after);
      if (best === null || start < best) best = start;
    }
    if (best !== null) return londonInstant(day, best);
  }
  return null;
}

export function tariffNow(rates: PlaceRates, nowMs: number, maxMinutes?: number | null): TariffNow {
  const at = londonMoment(nowMs);
  const hit = activeAt(rates, at.day, at.minute);
  if ("unknown" in hit) return {state: "unknown", reason: hit.unknown};
  if (hit.set === null) return {state: "outside", untilMs: nextPaidStart(rates, nowMs)};
  const set = hit.set;
  const bands = bandsOf(set);
  const endsAtMs = runEnd(rates, set, at.day);
  const paid = bands.filter((band) => band.pence >= 1);
  if (paid.length === 0) return {state: "free", untilMs: nextPaidStart(rates, endsAtMs)};
  const left = Math.ceil((endsAtMs - nowMs) / MINUTE_MS);
  const cap = maxMinutes != null && maxMinutes > 0 ? Math.min(left, maxMinutes) : left;
  const freeMinutes = bands.filter((band) => band.pence === 0).reduce((most, band) => Math.max(most, band.upTo), 0);
  if (cap <= freeMinutes) return {state: "free", untilMs: nextPaidStart(rates, endsAtMs)};
  const options: StayOption[] = [];
  for (const band of paid) {
    options.push({upTo: band.upTo, minutes: Math.min(band.upTo, cap), pence: band.pence});
    if (band.upTo >= cap) break;
  }
  return {state: "charging", set, startsAtMs: runStart(rates, set, at.day), endsAtMs, freeMinutes, options};
}

export type PriceRefusal = {
  ok: false;
  code: "no-charge-now" | "price-unknown" | "duration-invalid" | "nothing-to-pay" | "new-stay-needed";
  message: string;
};

export interface PricedStay {
  ok: true;
  pence: number;
  /* The stay bought, in minutes: cut at the end of charging time. */
  minutes: number;
  upTo: number;
  endsAtMs: number;
  /* What staff buy at the operator, e.g. "Up to 2 hours, Mon–Sat 8am–6pm". */
  label: string;
}

function notNow(now: TariffNow): PriceRefusal {
  if (now.state === "unknown") {
    return {ok: false, code: "price-unknown", message: "We can't tell the price here right now. Check the signs."};
  }
  return {ok: false, code: "no-charge-now", message: "There's no charge here right now, so there's nothing to pay."};
}

/* A new stay of `durationMinutes` from now. Past the end of charging time is free, so it isn't charged. */
export function priceStay(
  rates: PlaceRates,
  nowMs: number,
  durationMinutes: number,
  maxMinutes?: number | null,
): PricedStay | PriceRefusal {
  if (maxMinutes != null && maxMinutes > 0 && durationMinutes > maxMinutes) {
    return {ok: false, code: "duration-invalid", message: "That's longer than this car park's maximum stay."};
  }
  const now = tariffNow(rates, nowMs, maxMinutes);
  if (now.state !== "charging") return notNow(now);
  const minutes = Math.min(durationMinutes, Math.ceil((now.endsAtMs - nowMs) / MINUTE_MS));
  const band = bandsOf(now.set).find((item) => item.upTo >= minutes);
  if (!band) {
    return {ok: false, code: "duration-invalid", message: "That's longer than the longest stay on this car park's price list."};
  }
  if (band.pence < 1) {
    return {ok: false, code: "nothing-to-pay", message: "That stay is inside the free time, so there's nothing to pay."};
  }
  return {ok: true, pence: band.pence, minutes, upTo: band.upTo, endsAtMs: nowMs + minutes * MINUTE_MS,
    label: bandLabel(now.set, band.upTo)};
}

/*
 * Added time on a running stay: the band for the whole stay so far plus the
 * added time, less what the stay has already paid for parking. Operators
 * extend a session the same way.
 */
export function priceExtension(
  rates: PlaceRates,
  nowMs: number,
  stay: {startMs: number; paidUntilMs: number; paidPence: number},
  addMinutes: number,
  maxMinutes?: number | null,
): PricedStay | PriceRefusal {
  const now = tariffNow(rates, nowMs);
  if (now.state !== "charging") return notNow(now);
  if (stay.startMs < now.startsAtMs) {
    return {ok: false, code: "new-stay-needed",
      message: "Your stay began before this charging time. Pay for a new stay instead."};
  }
  const newEndMs = Math.min(stay.paidUntilMs + addMinutes * MINUTE_MS, now.endsAtMs);
  if (newEndMs <= stay.paidUntilMs) {
    return {ok: false, code: "no-charge-now",
      message: `There's no charge after ${clockLabel(londonMoment(now.endsAtMs).minute)}, so there's no need to add time.`};
  }
  const total = Math.ceil((newEndMs - stay.startMs) / MINUTE_MS);
  if (maxMinutes != null && maxMinutes > 0 && total > maxMinutes) {
    return {ok: false, code: "duration-invalid", message: "That would go past this car park's maximum stay."};
  }
  const band = bandsOf(now.set).find((item) => item.upTo >= total);
  if (!band) {
    return {ok: false, code: "duration-invalid", message: "That's longer than the longest stay on this car park's price list."};
  }
  const pence = band.pence - stay.paidPence;
  if (pence < 1) {
    return {ok: false, code: "nothing-to-pay", message: "What you've paid already covers this time."};
  }
  return {ok: true, pence, minutes: Math.ceil((newEndMs - stay.paidUntilMs) / MINUTE_MS), upTo: band.upTo,
    endsAtMs: newEndMs, label: bandLabel(now.set, band.upTo)};
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* 63 -> "Mon–Sat", 127 with bank holidays -> "every day incl. bank holidays". */
export function daysLabel(d: number, bh?: 1): string {
  if (d === 127) return bh ? "every day incl. bank holidays" : "every day";
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    if ((d & (1 << i)) === 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && (d & (1 << (j + 1))) !== 0) j += 1;
    if (i === j) parts.push(DAY_NAMES[i]);
    else if (j === i + 1) parts.push(`${DAY_NAMES[i]}, ${DAY_NAMES[j]}`);
    else parts.push(`${DAY_NAMES[i]}–${DAY_NAMES[j]}`);
    i = j + 1;
  }
  if (bh) parts.push("bank holidays");
  return parts.join(", ");
}

/* 480 -> "8am", 1110 -> "6:30pm", 0 and 1440 -> "midnight", 720 -> "noon". */
export function clockLabel(minute: number): string {
  if (minute === 0 || minute === DAY_MINUTES) return "midnight";
  if (minute === 720) return "noon";
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

export function timesLabel(f: number, t: number): string {
  return f === 0 && t === DAY_MINUTES ? "all day" : `${clockLabel(f)}–${clockLabel(t)}`;
}

/* 60 -> "Up to 1 hour", 90 -> "Up to 1 h 30 min", 1440 -> "All day". */
export function upToLabel(upTo: number): string {
  if (upTo >= DAY_MINUTES) return "All day";
  if (upTo < 60) return `Up to ${upTo} min`;
  const h = Math.floor(upTo / 60);
  const m = upTo % 60;
  if (m === 0) return `Up to ${h} ${h === 1 ? "hour" : "hours"}`;
  return `Up to ${h} h ${m} min`;
}

/* "Up to 2 hours, Mon–Sat 8am–6pm"; all-day sets leave the times out. */
export function bandLabel(set: RateSet, upTo: number): string {
  const times = timesLabel(set.f, set.t);
  return `${upToLabel(upTo)}, ${daysLabel(set.d, set.bh)}${times === "all day" ? "" : ` ${times}`}`;
}
