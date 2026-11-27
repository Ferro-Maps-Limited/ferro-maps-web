/* Stored evidence class. Exactly these four. There is no `official_partial`. */
export const SRC_TYPES = ["official", "gmaps", "onsite", "none"] as const;

export type SrcType = (typeof SRC_TYPES)[number];

export const AUD_CODES = ["c", "g", "p", "a"] as const;

export type AudCode = (typeof AUD_CODES)[number];

export const FEE_UNITS = ["hour", "visit", "day"] as const;

export type FeeUnit = (typeof FEE_UNITS)[number];

/* Stored pay mode. Exactly these three lowercase tokens. */
export const PAY_MODES = ["inapp", "handoff", "off"] as const;

export type PayMode = (typeof PAY_MODES)[number];

export type CanPark = 0 | 1 | 2 | 3;

/*
 * One stepped price list for some days and times, in UK time (Europe/London).
 * `d` is the days: 1 Monday, 2 Tuesday, 4 Wednesday … 64 Sunday, added up.
 * `bh` 1 means the set also applies on bank holidays. On a bank holiday only
 * sets with `bh` apply. `f` and `t` are minutes after midnight, from `f`
 * up to (not including) `t`; `t` 1440 is midnight at the end of the day.
 * `b` is flat pairs, shortest first: up-to minutes, then pence. Pence never
 * fall as the length rises. 0 pence is free. (Firestore can't hold an array
 * inside an array, so the pairs are flat.)
 */
export interface RateSet {
  d: number;
  bh?: 1;
  f: number;
  t: number;
  b: number[];
}

/*
 * A car park's stepped prices (FM-PP towns). Only on places without `fee`.
 * `h` is the car park's own nation's bank holidays, up to and including the
 * day `ht`. Any later day is unknown, so nothing can be paid then.
 */
export interface PlaceRates {
  v: 1;
  s: RateSet[];
  h: string[];
  ht: string;
}

/*
 * One private place inside `privateParkingCells/{geohash6}`.
 * New fields are optional. `srcType`, when present, is only a `SrcType`.
 */
export interface PrivatePlace {
  id: string;
  n: string;
  p: [number, number];
  s: CanPark;
  q?: "known";
  conf?: number;
  aud?: AudCode;
  approx?: true;
  free?: number;
  max?: number;
  fee?: number;
  feeUnit?: FeeUnit;
  auto?: true;
  payMode?: PayMode;
  operator?: string;
  src?: string;
  srcType?: SrcType;
  capturedAt?: string;
  verifiedAt?: string;
  hours?: string;
  addr?: string;
  locationCode?: string;
  locationProvider?: string;
  rates?: PlaceRates;
}

export interface PrivateCell {
  v: 1;
  cell: string;
  generatedAt: string;
  expiresAt: string;
  places: PrivatePlace[];
  shards?: number;
}

export interface CellWrite {
  id: string;
  data: PrivateCell;
}

export interface SourceRow {
  sheetRow: number;
  blank: boolean;
  values: Record<string, unknown>;
}

export function isSrcType(value: unknown): value is SrcType {
  return typeof value === "string" && (SRC_TYPES as readonly string[]).includes(value);
}
