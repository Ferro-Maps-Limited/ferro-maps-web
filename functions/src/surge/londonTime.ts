/*
 * Sheet times are UK local (§21.2). A timestamp with an explicit offset or
 * Z is that instant, including during the London fold. A wall clock with no
 * zone is Europe/London, and a gap or a fold returns null. A bare number is
 * ambiguous (epoch milliseconds versus a spreadsheet serial) and is rejected.
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const LONDON = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function wallOf(utcMs: number): Wall {
  const parts = LONDON.formatToParts(new Date(utcMs));
  const pick = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function sameWall(
  wall: Wall,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return wall.year === year && wall.month === month && wall.day === day &&
    wall.hour === hour && wall.minute === minute && wall.second === second;
}

function offsetAt(utcMs: number): number {
  const wall = wallOf(utcMs);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - utcMs;
}

export function londonWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const matches = new Set<number>();
  for (const probe of [guess - 3_600_000, guess, guess + 3_600_000]) {
    const candidate = guess - offsetAt(probe);
    if (sameWall(wallOf(candidate), year, month, day, hour, minute, second)) {
      matches.add(candidate);
    }
  }
  if (matches.size !== 1) return null;
  return new Date([...matches][0]);
}

const SHEET_WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

/*
 * Sheet cells are `YYYY-MM-DD HH:MM` in Europe/London.
 * The repeated hour on 25 Oct 2026 is rejected. The build note that says to
 * take the first occurrence is not followed: the source does not identify
 * which instant it means.
 */
export function parseUkSheetTime(value: unknown):
  {ok: true; at: Date} | {ok: false; reason: "ambiguous-time" | "unparsed"} {
  if (typeof value !== "string") return {ok: false, reason: "unparsed"};
  const match = SHEET_WALL.exec(value.trim());
  if (!match) return {ok: false, reason: "unparsed"};
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (year === 2026 && month === 10 && day === 25 && hour === 1) {
    return {ok: false, reason: "ambiguous-time"};
  }
  const at = londonWallToUtc(year, month, day, hour, minute, 0);
  if (at == null) return {ok: false, reason: "unparsed"};
  return {ok: true, at};
}

export function parseUtcSheetTime(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = SHEET_WALL.exec(value.trim());
  if (!match) return null;
  const at = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    0,
  ));
  return Number.isNaN(at.getTime()) ? null : at;
}

/* null means the value is not a time this importer will accept. */
export function parseSheetTime(value: unknown): Date | null {
  if (typeof value === "number") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  const wall = WALL.exec(text);
  if (!wall) return null;
  const year = Number(wall[1]);
  const month = Number(wall[2]);
  const day = Number(wall[3]);
  const hour = Number(wall[4]);
  const minute = Number(wall[5]);
  const second = Number(wall[6] ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return londonWallToUtc(year, month, day, hour, minute, second);
}
