import {SplitResult, TileMember} from "./splitTile";

export interface TileCountLine {
  g5: string;
  staticActive: number;
  liveActive: number | null;
  total: number;
  over: boolean;
  shards: number[];
}

export function tileReport<T extends TileMember>(
  members: T[],
  split: SplitResult<T>,
  liveRead: boolean,
): {lines: TileCountLine[], tilesOver500: number} {
  const lines: TileCountLine[] = [];
  const g5s = new Set(members.map((member) => member.g5));
  for (const g5 of [...g5s].sort()) {
    const here = members.filter((member) => member.g5 === g5);
    const staticActive = here.filter((member) => member.staticPin).length;
    const liveActive = here.length - staticActive;
    const shards = split.groups
      .filter((group) => group.g5 === g5)
      .map((group) => group.members.length);
    lines.push({
      g5,
      staticActive,
      liveActive: liveRead ? liveActive : null,
      total: liveRead ? here.length : staticActive,
      over: here.length > 500,
      shards,
    });
  }
  const tilesOver500 = new Set(split.unassigned.map((member) => member.g5)).size;
  return {lines, tilesOver500};
}

export function formatTileReport(
  lines: TileCountLine[],
  tilesOver500: number,
  liveRead: boolean,
): string {
  const rows = lines.map((line) => {
    const live = line.liveActive == null ? "not-read" : String(line.liveActive);
    const flag = line.over ? " FLAG over 500" : "";
    const shards = line.shards.length ? ` shards=${line.shards.join("+")}` : "";
    return `${line.g5} static=${line.staticActive} live=${live} total=${line.total}${shards}${flag}`;
  });
  const liveNote = liveRead ?
    "Live counts were read from this project." :
    "Live counts were not read. Pass an emulator demo- project to include them.";
  return [
    ...rows,
    liveNote,
    `tilesOver500: ${tilesOver500}`,
    "pinsV1 stays off until tilesOver500 is 0 and this static seed has been applied.",
  ].join("\n");
}
