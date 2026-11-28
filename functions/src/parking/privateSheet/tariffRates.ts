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
 *   "Monday to Friday 8:30am - 6:30pm: every 15 Minutes" and "per 1 hour
 *   (pro rata)": a repeating price, sold as stays of 15, 30 and 45 minutes
 *   and then whole hours, up to the max stay and the end of the charge time
 *   (London's on-street bays)
 * A band with no days or times takes them from its Notes ("All Week 8:00am -
 * 10:00pm (8:00am - 10:00pm). Last tariff update…", or several charge times
 * split by `;`) or from the car park's Charging Days/Hours. Anything else is unclear and left out, so it is never
 * on sale. Pre-book and live quotes, season tickets, permits and other
 * vehicles are not stays a driver buys at the car park, so they are skipped,
 * and so are diesel surcharges and free periods that can't be placed (the
 * car park simply doesn't charge then). A vehicle list such as "; car, lgv"
 * keeps a band only when it names cars.
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
  String.raw`early bird`, String.raw`weekly`, String.raw`monthly`, String.raw`diesel`,
].join("|"));
const VEHICLE = String.raw`(?:cars?|lgvs?|motorcycles?|motorbikes?|mopeds?|vans?|hgvs?|coach(?:es)?|bus(?:es)?|minibus(?:es)?)`;
const VEHICLE_LIST = new RegExp(String.raw`;\s*(${VEHICLE}(?:\s*,\s*${VEHICLE})*)\s*$`);

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

/* A repeating price: `pence` for every `minutes`, or pro rata within them. */
type Length = {minutes: number; until?: number; every?: {proRata: boolean}} | "long" | null;

/* "every 15 minutes", "for every 1 hour", "per 1 hour (pro rata)", "per 15 minutes (pro rata)". */
export function parseIncrement(raw: string): Length {
  const s = norm(raw);
  const m = /^(?:for every|every|per)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)(\s*\(pro rata\))?$/.exec(s);
  if (!m) return null;
  const minutes = Math.round(Number(m[1]) * (m[2].startsWith("m") ? 1 : 60));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) return null;
  return {minutes, every: {proRata: Boolean(m[3])}};
}

function parseAmount(raw: string): Length {
  return parseIncrement(raw) ?? parseLength(raw);
}

/* "up to 2 hours", "3 hours", "0-30 minutes", "24hrs", "all day (until 6pm)". */
export function parseLength(raw: string): Length {
  const s = norm(raw);
  // "24 hours / 1 day": two names for one stay.
  const alternatives = s.split(/\s+\/\s+/);
  if (alternatives.length === 2) {
    const [a, b] = alternatives.map((part) => parseLength(part));
    if (a && b && a !== "long" && b !== "long" && a.minutes === b.minutes && a.until === undefined && b.until === undefined) {
      return a;
    }
    return a === "long" && b === "long" ? "long" : null;
  }
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
  every?: {proRata: boolean};
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
    if (range) return {len: parseAmount(p[1]), inner: range};
  }
  return {len: parseAmount(raw)};
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
  s = s.replace(/;\s*rover only\s*$/, "").trim();
  s = s.replace(VEHICLE_LIST, (_, list: string) => {
    if (!list.split(/\s*,\s*/).some((item) => /^cars?$/.test(item))) otherVehicle = true;
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
    return {
      ...(ctx ? {ctx} : {}),
      minutes: len.minutes,
      ...(len.until !== undefined ? {until: len.until} : {}),
      pence,
      ...(len.every ? {every: len.every} : {}),
    };
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
  // A length or a repeating price on its own, "All Day (until 6pm)" included.
  const bare = parseAmount(s);
  if (bare) return done(undefined, bare);
  const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(s);
  if (paren) {
    const len = parseAmount(paren[1]);
    if (len) return done(parseContext(paren[2]), len);
  }
  const dash = /^(.+?)\s+-\s+(.+)$/.exec(s);
  if (dash) {
    const len = parseAmount(dash[1]);
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

/*
 * Every charge time in the first sentence of the Notes ("Monday to Friday
 * 8:30am - Midnight (8:30am - 10:00am); Saturdays 8:30am - 1:30pm (8:30am -
 * 1:30pm); Car, LGV"). A vehicle list keeps the band only when it names cars,
 * and a band for event days alone is skipped (event days aren't known ahead).
 * `contexts` is empty unless every other part is a charge time.
 */
export function notesContexts(notes: string): {contexts: RateContext[]; skip: boolean} {
  const first = norm(notes).split(/\.(?:\s|$)/)[0] ?? "";
  let skip = false;
  let event = false;
  const parts = first.split(/\s*;\s*/).filter(Boolean).filter((part) => {
    const vehicles = new RegExp(String.raw`^${VEHICLE}(?:\s*,\s*${VEHICLE})*$`).exec(part);
    if (vehicles) {
      if (!part.split(/\s*,\s*/).some((item) => /^cars?$/.test(item))) skip = true;
      return false;
    }
    if (/^event days?$/.test(part)) {
      event = true;
      return false;
    }
    return true;
  });
  if (parts.length === 0) return {contexts: [], skip: skip || event};
  const contexts = parts.map((part) => parseContext(part));
  if (!contexts.every((ctx): ctx is RateContext => ctx !== null)) return {contexts: [], skip};
  return {contexts, skip};
}

/* The stays a repeating price is sold as: 15-minute steps (or its own) to an hour, then hours. */
export function incrementBands(minutes: number, pence: number, proRata: boolean, capMinutes: number): number[] {
  // Pro rata is sold in 15-minute stays; so is a short step that 15 minutes is a whole number of.
  const unit = proRata || (minutes < 15 && 15 % minutes === 0) ? 15 : minutes;
  const later = unit <= 60 && 60 % unit === 0 ? 60 : unit;
  const lengths: number[] = [];
  for (let m = unit; m <= capMinutes && lengths.length < MAX_BANDS; m += m < 60 ? unit : later) {
    if (m > 60 && m % later !== 0) continue;
    lengths.push(m);
  }
  const out: number[] = [];
  for (const m of lengths) {
    const price = proRata ? Math.round((pence * m) / minutes) : (m / minutes) * pence;
    if (!Number.isInteger(price)) return [];
    out.push(m, price);
  }
  return out;
}

/* "Charge times (RingGo): Monday to Saturday 8:00am - 6:00pm; Sundays; Bank Holiday." */
export function chargingContexts(raw: string): RateContext[] {
  const s = norm(raw)
    .replace(/^(?:ringgo\s+)?charge times(?:\s*\([^)]*\))?\s*:?\s*/, "")
    .replace(/^charging\s*:?\s*/, "")
    .replace(/^chargeable\s+/, "")
    // "all week (ringgo)": a bracket that isn't a time is a label.
    .replace(/\s*\(([^()]*)\)/g, (whole: string, inner: string) => (parseRange(inner) ? whole : ""));
  const first = s.split(/\.(?:\s|$)/)[0] ?? "";
  return first.split(/\s*;\s*/).map((seg) => parseContext(seg)).filter((ctx): ctx is RateContext => ctx !== null);
}

/*
 * Days and times for one band. A band without times takes them from a
 * charge time for the same days; "all week" and bank holidays alone mean all
 * day. Otherwise the band is unclear.
 */
function placeBand(parsed: ParsedBand, fromNotes: RateContext | null, charging: RateContext[]): RateSet | null {
  const start = parsed.ctx ?? fromNotes ?? (charging.length === 1 ? charging[0] : undefined);
  return placeIn(parsed, start, fromNotes, charging);
}

function placeIn(
  parsed: ParsedBand,
  start: RateContext | undefined,
  fromNotes: RateContext | null,
  charging: RateContext[],
): RateSet | null {
  let ctx = start;
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

/*
 * The sets one band belongs to. A band with no days or times whose Notes
 * list several charge times is in each of them.
 */
function placeAll(parsed: ParsedBand, notes: string, charging: RateContext[]): RateSet[] | "skip" {
  const fromNotes = notesContext(notes);
  if (!parsed.ctx && !fromNotes) {
    const listed = notesContexts(notes);
    if (listed.skip) return "skip";
    let several = listed.contexts;
    // Charge times such as "Monday to Saturday 8:30am - 5:30pm; Sundays; Bank
    // Holiday": the band is sold in each timed one. A day listed without times
    // is a day the car park doesn't charge.
    if (several.length === 0 && charging.length > 1) several = charging.filter((ctx) => ctx.range);
    if (several.length > 0) {
      const sets = several.map((ctx) => placeIn(parsed, ctx, null, charging));
      return sets.every((set): set is RateSet => set !== null) ? sets : [];
    }
  }
  const one = placeBand(parsed, fromNotes, charging);
  return one ? [one] : [];
}

export function parseFmppRates(bands: FmppTariffBand[], chargingText: string, maxMinutes?: number): RatesOutcome {
  const checked = bands.filter((band) => confidenceOk(band.confidence));
  if (checked.length === 0) return {ok: false, reason: "no-checked-bands"};
  const charging = chargingContexts(chargingText);
  // `soft` pairs come from a repeating price: where one meets another price
  // for the same stay, the higher is kept, so a stay is never sold for less.
  const groups = new Map<string, {set: RateSet; pairs: Array<[number, number, boolean]>}>();
  let unclear = 0;
  let read = 0;
  for (const band of checked) {
    const parsed = parseBand(band);
    if (parsed === "skip" || parsed === "long") continue;
    const placing = parsed === "unclear" ? [] : placeAll(parsed, band.notes, charging);
    if (placing === "skip") continue;
    const placed = placing;
    if (placed.length === 0 || parsed === "unclear") {
      // A free period that can't be placed is time the car park doesn't charge.
      if (band.pricePence !== 0) unclear += 1;
      continue;
    }
    for (const set of placed) {
      const key = `${set.d}|${set.bh ?? 0}|${set.f}|${set.t}`;
      const group = groups.get(key) ?? {set: {...set, b: []}, pairs: []};
      if (parsed.every) {
        const cap = Math.min(maxMinutes ?? set.t - set.f, set.t - set.f);
        const steps = incrementBands(parsed.minutes, parsed.pence, parsed.every.proRata, cap);
        for (let i = 0; i < steps.length; i += 2) group.pairs.push([steps[i], steps[i + 1], true]);
        if (steps.length === 0) {
          unclear += 1;
          continue;
        }
      } else {
        group.pairs.push([parsed.minutes, parsed.pence, false]);
      }
      groups.set(key, group);
    }
    read += 1;
  }
  if (read === 0) return {ok: false, reason: unclear > 0 ? "unreadable" : "quotes-only"};
  const sets: RateSet[] = [];
  let notRising = false;
  for (const {set, pairs: raw} of groups.values()) {
    raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Same stay twice: the higher price where a repeating price is involved.
    const merged: Array<[number, number, boolean]> = [];
    for (const pair of raw) {
      const last = merged[merged.length - 1];
      if (last && last[0] === pair[0] && (last[2] || pair[2])) {
        merged[merged.length - 1] = [pair[0], Math.max(last[1], pair[1]), last[2] && pair[2]];
      } else {
        merged.push(pair);
      }
    }
    // A free stay longer than the shortest paid one ("24 hours £0" beside
    // "1 hour £2.10") is the free time outside the charge time, not this set's.
    const firstPaid = merged.find((pair) => pair[1] > 0)?.[0];
    const pairs = merged
      .filter(([minutes, pence]) => pence > 0 || firstPaid === undefined || minutes < firstPaid)
      .map(([minutes, pence]) => [minutes, pence] as [number, number]);
    const unique = pairs.filter((pair, i) => i === 0 || pair[0] !== pairs[i - 1][0] || pair[1] !== pairs[i - 1][1]);
    const clash = unique.some((pair, i) => i > 0 && pair[0] === unique[i - 1][0]);
    const falls = unique.some((pair, i) => i > 0 && pair[1] < unique[i - 1][1]);
    // More stays than the app lists: the shortest ones and the longest.
    if (!clash && !falls && unique.length > MAX_BANDS) unique.splice(MAX_BANDS - 1, unique.length - MAX_BANDS);
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
