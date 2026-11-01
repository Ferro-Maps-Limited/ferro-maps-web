/** Stored evidence class. Exactly these four. There is no `official_partial`. */
export const SRC_TYPES = ["official", "gmaps", "onsite", "none"] as const;

export type SrcType = (typeof SRC_TYPES)[number];

export const AUD_CODES = ["c", "g", "p", "a"] as const;

export type AudCode = (typeof AUD_CODES)[number];

export const FEE_UNITS = ["hour", "visit", "day"] as const;

export type FeeUnit = (typeof FEE_UNITS)[number];

export type CanPark = 0 | 1 | 2 | 3;

/**
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
  operator?: string;
  src?: string;
  srcType?: SrcType;
  capturedAt?: string;
  verifiedAt?: string;
  hours?: string;
  addr?: string;
  locationCode?: string;
  locationProvider?: string;
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
