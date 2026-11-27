import type {FmppTariffBand} from "./fmpp.js";
import type {RateSet} from "./types.js";

/*
 * FM-PP tariff bands -> stepped price lists (`rates.s`).
 *
 * The wording is free text, so this reads only what it is sure of:
 *   "Monday to Saturday 8:00am - 6:00pm: up to 2 hours"
 *   "up to 2 hours (Monday to Saturday 8:00am - 6:00pm)"
 *   "Sundays (Midnight - 6:00pm): up to 4 hours"
 *   "All Week: up to 1 hour", "Bank Holiday: 24 hours", "2 hours — all week"
 * A band with no days or times takes them from its Notes ("All Week 8:00am -
 * 10:00pm (8:00am - 10:00pm). Last tariff update…") or from the car park's
 * Charging Days/Hours. Anything else is unclear and left out, so it is never
 * on sale. Pre-book and live quotes, season tickets, permits and other
 * vehicles are not stays a driver buys at the car park, so they are skipped.
 * "[rover permit]" stays in: the team marks those bands as the standard tariff.
 */

export type RatesOutcome =
  | {ok: true; sets: RateSet[]; unclear: number}
  | {ok: false; reason: "no-checked-bands" | "quotes-only" | "unreadable" | "not-rising" | "free-only"};

const MAX_SETS = 12;
const MAX_BANDS = 16;
const ALL_DAYS = 127;

export function confidenceOk(value: string): boolean {
  const folded = value.trim().toLowerCase();
  return folded === "verified" || folded === "partial";
}

export function isConcession(duration: string, notes: string): boolean {
  return /\b(?:blue badge|concession|twilight|validated)\b/i.test(`${duration} ${notes}`);
}

const SKIP = new RegExp([
  String.raw`pre-?book`, String.raw`\bquote`, String.raw`\bpermit`, String.raw`season`, String.raw`contract`,
  String.raw`lost ticket`, String.raw`penalty`, String.raw`resident`, String.raw`\bstaff\b`, String.raw`\bcoach`,
  String.raw`\bhgv\b`, String.raw`lorry`, String.raw`evening`, String.raw`overnight`, String.raw`\bnight`,
  String.raw`early bird`, String.raw`weekly`, String.raw`monthly`,
].join("|"));

function norm(value: string): string {
  return value.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ").trim();
}

const TIME = String.raw`(?:midnight|noon|midday|\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})`;
const RANGE = new RegExp(String.raw`^(${TIME})\s*(?:-|to)\s*(${TIME})$`);
const DAYS_THEN_RANGE = new RegExp(
  String.raw`^(.*?)[\s:,]*(${TIME}\s*(?:-|to)\s*${TIME}|24 ?hours|24 ?hrs|all day)$`,
);

/* Minutes after midnight. Midnight is 0 at the start of a range and 1440 at its end. */
function parseTime(raw: string, end: boolean): number | null {
  const s = raw.trim();
  if (s === "midnight") return end ? 1440 : 0;
  if (s === "noon" || s === "midday") return 720;
  let m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    const value = (h % 12 + (m[3] === "pm" ? 12 : 0)) * 60 + min;
    return end && value === 0 ? 1440 : value;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const value = Number(m[1]) * 60 + Number(m[2]);
    if (Number(m[2]) > 59 || value > 1440) return null;
    if (end) return value === 0 ? 1440 : value;
    return value === 1440 ? null : value;
  }
  return null;
}

function parseRange(raw: string): [number, number] | null {
  const s = raw.trim();
  if (/^(?:24 ?hours|24 ?hrs|all day|24\/7)$/.test(s)) return [0, 1440];
  const m = RANGE.exec(s);
  if (!m) return null;
  const from = parseTime(m[1], false);
  const to = parseTime(m[2], true);
  if (from == null || to == null || to <= from) return null;
  return [from, to];
}

const DAY_INDEX: Record<string, number> = {
  monday: 0, mon: 0, tuesday: 1, tue: 1, tues: 1, wednesday: 2, wed: 2, thursday: 3, thu: 3, thur: 3,
  thurs: 3, friday: 4, fri: 4, saturday: 5, sat: 5, sunday: 6, sun: 6,
};

function dayIndex(word: string): number | null {
  const w = word.trim();
  if (w in DAY_INDEX) return DAY_INDEX[w];
  const single = w.endsWith("s") ? w.slice(0, -1) : w;
  return single in DAY_INDEX ? DAY_INDEX[single] : null;
}

function parseDays(raw: string): {d: number; bh: boolean} | null {
  let bh = false;
  let s = raw.trim().replace(/[.,;:]+$/, "");
  s = s.replace(/\b(?:inc\.?|incl\.?|including)\s+bank holidays?/g, () => {
    bh = true;
    return "";
  });
  s = s.replace(/\b(?:exc\.?|excl\.?|excluding|except)\s+bank holidays?/g, "");
  const items = s.split(/\s*(?:,|&|\+|\band\b)\s*/).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return bh ? {d: 0, bh} : null;
  let d = 0;
  for (const item of items) {
    if (/^(?:all week|every ?day|daily|7 days|seven days|all days|mon(?:day)? ?(?:-|to) ?sun(?:day)?)$/.test(item)) {
      d |= ALL_DAYS;
      continue;
    }
    if (/^weekdays?$/.test(item)) {
      d |= 31;
      continue;
    }
    if (/^weekends?$/.test(item)) {
      d |= 96;
      continue;
    }
    if (/^bank holidays?$/.test(item)) {
      bh = true;
      continue;
    }
    const span = /^([a-z]+)\s*(?:-|to)\s*([a-z]+)$/.exec(item);
    if (span) {
      const a = dayIndex(span[1]);
      const b = dayIndex(span[2]);
      if (a == null || b == null) return null;
      for (let i = a; ; i = (i + 1) % 7) {
        d |= 1 << i;
        if (i === b) break;
      }
      continue;
    }
    const one = dayIndex(item);
    if (one == null) return null;
    d |= 1 << one;
  }
  return d === 0 && !bh ? null : {d, bh};
}

export interface RateContext {
  d: number;
  bh: boolean;
  range?: [number, number];
}

/*
 * "monday to saturday 8:00am - 6:00pm", "sundays (midnight - 6:00pm)",
 * "monday to friday 8:00am - midnight (8:00am - 6:00pm)" (the band's own
 * window inside the charge time), "all week, inc. bank holidays".
 */
export function parseContext(raw: string): RateContext | null {
  let s = norm(raw).replace(/[.;:,]+$/, "").trim();
  let inner: [number, number] | undefined;
  const paren = /\s*\(([^()]*)\)$/.exec(s);
  if (paren) {
    const range = parseRange(paren[1]);
    if (range) {
      inner = range;
      s = s.slice(0, paren.index).trim();
    }
  }
  const segs = s.split(/\s*;\s*/).filter(Boolean);
  if (segs.length === 0) return null;
  let days = parseDays(segs[0]);
  let outer: [number, number] | undefined;
  if (!days) {
    const m = DAYS_THEN_RANGE.exec(segs[0]);
    if (!m) return null;
    days = parseDays(m[1]);
    const range = parseRange(m[2]);
    if (!days || !range) return null;
    outer = range;
  }
  for (const seg of segs.slice(1)) {
    const range = parseRange(seg);
    if (!range || (inner && (inner[0] !== range[0] || inner[1] !== range[1]))) return null;
    inner = range;
  }
  if (inner && outer && (inner[0] < outer[0] || inner[1] > outer[1])) return null;
  const range = inner ?? outer;
  return range ? {d: days.d, bh: days.bh, range} : {d: days.d, bh: days.bh};
}

type Length = {minutes: number; until?: number} | "long" | null;

/* "up to 2 hours", "3 hours", "0-30 minutes", "24hrs", "all day (until 6pm)". */
export function parseLength(raw: string): Length {
  const s = norm(raw);
  if (/^(?:all day|full day|whole day)$/.test(s)) return {minutes: 1440};
  const until = new RegExp(String.raw`^all day \(until (${TIME})\)$`).exec(s);
  if (until) {
    const t = parseTime(until[1], true);
    return t == null ? null : {minutes: 1440, until: t};
  }
  if (/^(?:\d+\s*)?(?:weeks?|months?|calendar months?|years?)\b/.test(s)) return "long";
  const number = String.raw`(\d+(?:\.\d+)?)`;
  const m = new RegExp(String.raw`^(?:up to\s+)?(?:${number}\s*(?:-|to)\s*)?${number}\s*(minutes?|mins?|hours?|hrs?|h|days?)$`).exec(s);
  if (!m) return null;
  const amount = Number(m[2]);
  const per = m[3].startsWith("m") ? 1 : m[3].startsWith("d") ? 1440 : 60;
  const minutes = Math.round(amount * per);
  if (!Number.isFinite(minutes) || minutes < 1 || Math.abs(amount * per - minutes) > 1e-6) return null;
  return minutes > 1440 ? "long" : {minutes};
}

interface ParsedBand {
  ctx?: RateContext;
  minutes: number;
  until?: number;
  pence: number;
}

function withInner(ctx: RateContext | undefined, inner: [number, number] | undefined): RateContext | undefined | null {
  if (!inner) return ctx;
  if (!ctx) return null;
  if (ctx.range && (inner[0] < ctx.range[0] || inner[1] > ctx.range[1])) return null;
  return {...ctx, range: inner};
}

function lengthAndInner(raw: string): {len: Length; inner?: [number, number]} {
  const p = /^(.*?)\s*\(([^()]*)\)$/.exec(raw);
  if (p) {
    const range = parseRange(p[2]);
    if (range) return {len: parseLength(p[1]), inner: range};
  }
  return {len: parseLength(raw)};
}

export function parseBand(band: FmppTariffBand): ParsedBand | "skip" | "long" | "unclear" {
  let s = norm(band.duration);
  if (!s) return "unclear";
  let otherVehicle = false;
  s = s.replace(/\s*\[([^\]]*)\]/g, (_, tag: string) => {
    const t = tag.trim();
    if (t !== "rover permit" && !t.split(/\s*,\s*/).includes("car")) otherVehicle = true;
    return "";
  }).trim();
  if (otherVehicle || SKIP.test(s) || isConcession(band.duration, band.notes)) return "skip";
  let free = false;
  s = s.replace(/\s*\(free\)/g, () => {
    free = true;
    return "";
  }).trim();
  const pence = free ? band.pricePence ?? 0 : band.pricePence;
  if (pence == null || pence < 0 || (free && pence !== 0)) return "unclear";
  const done = (ctx: RateContext | undefined | null, len: Length): ParsedBand | "long" | "unclear" => {
    if (len === "long") return "long";
    if (len === null || ctx === null) return "unclear";
    return {...(ctx ? {ctx} : {}), minutes: len.minutes, ...(len.until !== undefined ? {until: len.until} : {}), pence};
  };
  const colon = /^(.+?):\s+(.+)$/.exec(s);
  // "24hrs (all week): 7 days" is a multi-day ticket, whatever comes before it.
  if (colon && lengthAndInner(colon[2]).len === "long") return "long";
  if (colon) {
    const ctx = parseContext(colon[1]);
    if (ctx) {
      const {len, inner} = lengthAndInner(colon[2]);
      return done(withInner(ctx, inner), len);
    }
  }
  // A length on its own, "All Day (until 6pm)" included.
  const bare = parseLength(s);
  if (bare) return done(undefined, bare);
  const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(s);
  if (paren) {
    const len = parseLength(paren[1]);
    if (len) return done(parseContext(paren[2]), len);
  }
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(s);
  if (dash) {
    const len = parseLength(dash[1]);
    const ctx = parseContext(dash[2]);
    if (len && ctx) return done(ctx, len);
  }
  return "unclear";
}

/* The first sentence of the Notes, when it is a charge time ("All Week 8:00am - 10:00pm (…)."). */
export function notesContext(notes: string): RateContext | null {
  const first = norm(notes).split(/\.(?:\s|$)/)[0] ?? "";
  return first ? parseContext(first) : null;
}

/* "Charge times (RingGo): Monday to Saturday 8:00am - 6:00pm; Sundays; Bank Holiday." */
export function chargingContexts(raw: string): RateContext[] {
  const s = norm(raw)
    .replace(/^(?:ringgo\s+)?charge times(?:\s*\([^)]*\))?\s*:?\s*/, "")
    .replace(/^charging\s*:?\s*/, "")
    .replace(/^chargeable\s+/, "");
  const first = s.split(/\.(?:\s|$)/)[0] ?? "";
  return first.split(/\s*;\s*/).map((seg) => parseContext(seg)).filter((ctx): ctx is RateContext => ctx !== null);
}

/*
 * Days and times for one band. A band without times takes them from a
 * charge time for the same days; "all week" and bank holidays alone mean all
 * day. Otherwise the band is unclear.
 */
function placeBand(parsed: ParsedBand, fromNotes: RateContext | null, charging: RateContext[]): RateSet | null {
  let ctx = parsed.ctx ?? fromNotes ?? (charging.length === 1 ? charging[0] : undefined);
  if (!ctx) return null;
  if (!ctx.range) {
    const days = ctx;
    const sameDays = [fromNotes, ...charging]
      .filter((c): c is RateContext => c != null && c.d === days.d && c.bh === days.bh);
    const timed = sameDays.find((c) => c.range);
    if (timed?.range) ctx = {...ctx, range: timed.range};
    else if (sameDays.length > 0 || ctx.d === ALL_DAYS || (ctx.d === 0 && ctx.bh)) ctx = {...ctx, range: [0, 1440]};
    else return null;
  }
  const [f, t] = ctx.range as [number, number];
  if (parsed.until !== undefined && parsed.until !== t) return null;
  return {d: ctx.d, ...(ctx.bh ? {bh: 1 as const} : {}), f, t, b: [parsed.minutes, parsed.pence]};
}

export function parseFmppRates(bands: FmppTariffBand[], chargingText: string): RatesOutcome {
  const checked = bands.filter((band) => confidenceOk(band.confidence));
  if (checked.length === 0) return {ok: false, reason: "no-checked-bands"};
  const charging = chargingContexts(chargingText);
  const groups = new Map<string, {set: RateSet; pairs: Array<[number, number]>}>();
  let unclear = 0;
  let read = 0;
  for (const band of checked) {
    const parsed = parseBand(band);
    if (parsed === "skip" || parsed === "long") continue;
    const placed = parsed === "unclear" ? null : placeBand(parsed, notesContext(band.notes), charging);
    if (!placed || parsed === "unclear") {
      unclear += 1;
      continue;
    }
    read += 1;
    const key = `${placed.d}|${placed.bh ?? 0}|${placed.f}|${placed.t}`;
    const group = groups.get(key) ?? {set: {...placed, b: []}, pairs: []};
    group.pairs.push([parsed.minutes, parsed.pence]);
    groups.set(key, group);
  }
  if (read === 0) return {ok: false, reason: unclear > 0 ? "unreadable" : "quotes-only"};
  const sets: RateSet[] = [];
  let notRising = false;
  for (const {set, pairs} of groups.values()) {
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const unique = pairs.filter((pair, i) => i === 0 || pair[0] !== pairs[i - 1][0] || pair[1] !== pairs[i - 1][1]);
    const clash = unique.some((pair, i) => i > 0 && pair[0] === unique[i - 1][0]);
    const falls = unique.some((pair, i) => i > 0 && pair[1] < unique[i - 1][1]);
    if (clash || falls || unique.length > MAX_BANDS) {
      notRising = notRising || falls;
      unclear += unique.length;
      continue;
    }
    sets.push({...set, b: unique.flat()});
  }
  if (sets.length === 0) return {ok: false, reason: notRising ? "not-rising" : "unreadable"};
  if (sets.length > MAX_SETS) return {ok: false, reason: "unreadable"};
  if (!sets.some((set) => set.b.some((value, i) => i % 2 === 1 && value >= 1))) return {ok: false, reason: "free-only"};
  sets.sort((a, b) => (a.bh ?? 0) - (b.bh ?? 0) || a.d - b.d || a.f - b.f || a.t - b.t);
  return {ok: true, sets, unclear};
}
