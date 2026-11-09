import {londonLocalToUtcMs, parseSheetTime} from "./time.js";

export type StartTimeSource = "sheet_exact" | "sheet_start" | "sheet_doors" | "derived_from_finish";

/* When the kick-off cell has no clock time, the start is the expected finish minus 3 hours. */
export const DERIVED_START_BEFORE_FINISH_MS = 3 * 60 * 60 * 1000;

export interface ResolvedKickoff {
  kickOffMs: number;
  startTimeSource: StartTimeSource;
}

export type KickoffResolution =
  | ({status: "ok"} & ResolvedKickoff)
  | {status: "skip"}
  | {status: "reject"};

const EXACT_CELL = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})[ T]\d{1,2}:\d{2}(?::\d{2})?$/;
const EVENT_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:-|$)/;
const CLOCK = /~?\s*(\d{1,2}):(\d{2})/g;

interface ClockHit {
  hour: number;
  minute: number;
  kind: "start" | "doors" | "plain" | "ignore";
}

export function eventIdDate(sheetEventId: string): {year: number; month: number; day: number} | null {
  const match = EVENT_DATE.exec(sheetEventId.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (londonLocalToUtcMs(year, month, day, 0, 0) == null) return null;
  return {year, month, day};
}

export function confidencePercent(yes: number, total: number): number {
  return Math.round((100 * yes) / total);
}

function kindFor(before: string, previous: ClockHit["kind"] | null): ClockHit["kind"] {
  if (previous && /^[\s/\-–—,]*$/.test(before)) return previous;
  const tail = before.toLowerCase().replace(/~/g, " ").replace(/\s+/g, " ").trim().slice(-48);
  if (/(?:^|[\s,(/])(?:end|ends|finish|ft)\s*$/.test(tail)) return "ignore";
  if (/readings\s+from\s*$/.test(tail)) return "ignore";
  if (/(?:^|[\s,(/])doors\s*$/.test(tail)) return "doors";
  if (/(?:^|[\s,(/])(?:show|listed|face-?off|faceoff|ringwalks)\s*$/.test(tail)) return "start";
  if (/(?:^|[\s,(/])start\s*$/.test(tail)) return "start";
  return "plain";
}

function clockHits(cell: string): ClockHit[] {
  const hits: ClockHit[] = [];
  const pattern = new RegExp(CLOCK.source, "g");
  let previous: ClockHit["kind"] | null = null;
  let cursor = 0;
  let match = pattern.exec(cell);
  while (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const before = cell.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (hour > 23 || minute > 59) {
      previous = "ignore";
    } else {
      const kind = kindFor(before, previous);
      hits.push({hour, minute, kind});
      previous = kind;
    }
    match = pattern.exec(cell);
  }
  return hits;
}

function place(date: {year: number; month: number; day: number}, hit: ClockHit): number | null {
  return londonLocalToUtcMs(date.year, date.month, date.day, hit.hour, hit.minute);
}

function firstPlaced(
  hits: ClockHit[],
  date: {year: number; month: number; day: number},
  kind: ClockHit["kind"],
): number | null {
  for (const hit of hits) {
    if (hit.kind !== kind) continue;
    const ms = place(date, hit);
    if (ms != null) return ms;
  }
  return null;
}

function afterFinish(kickOffMs: number, fullTimeMs: number | null): boolean {
  return fullTimeMs != null && kickOffMs > fullTimeMs;
}

/*
 * The kick-off column is often a note, not a full date. The day always comes from
 * the event id. A full date and time in the cell is kept as written.
 */
export function resolveKickoff(input: {
  sheetEventId: string;
  kickoffCell: unknown;
  fullTimeMs: number | null;
}): KickoffResolution {
  const cell = typeof input.kickoffCell === "string" ? input.kickoffCell.trim() : "";
  if (EXACT_CELL.test(cell)) {
    const exact = parseSheetTime(cell, "uk");
    if (exact != null) {
      if (afterFinish(exact, input.fullTimeMs)) return {status: "reject"};
      return {status: "ok", kickOffMs: exact, startTimeSource: "sheet_exact"};
    }
  }
  const date = eventIdDate(input.sheetEventId);
  if (!date) return {status: "skip"};
  const hits = clockHits(cell);
  const start = firstPlaced(hits, date, "start") ?? firstPlaced(hits, date, "plain");
  const doors = firstPlaced(hits, date, "doors");
  const chosen = start != null ?
    {kickOffMs: start, startTimeSource: "sheet_start" as const} :
    doors != null ?
      {kickOffMs: doors, startTimeSource: "sheet_doors" as const} :
      null;
  if (chosen) {
    if (afterFinish(chosen.kickOffMs, input.fullTimeMs)) return {status: "reject"};
    return {status: "ok", ...chosen};
  }
  if (input.fullTimeMs == null) return {status: "skip"};
  return {
    status: "ok",
    kickOffMs: input.fullTimeMs - DERIVED_START_BEFORE_FINISH_MS,
    startTimeSource: "derived_from_finish",
  };
}
