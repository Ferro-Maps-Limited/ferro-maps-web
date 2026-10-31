export const TILE_CAP = 500;
export const TILE_WARN_AT = 450;
export const MAX_EXTRA_SHARDS = 8;

export interface TileMember {
  id: string;
  g5: string;
  staticPin: boolean;
  windowEndMs: number;
}

export interface ShardGroup<T extends TileMember> {
  g5: string;
  shard: number;
  members: T[];
}

export interface SplitResult<T extends TileMember> {
  groups: ShardGroup<T>[];
  unassigned: T[];
  /** g5 cells whose pre-split active count is over 500. */
  rawOver: string[];
  /** True when every assigned shard is within the cap and nothing is left over. */
  tilesFit: boolean;
  warnG5: string[];
}

/**
 * Pack each g5 into the base tile plus up to 8 siblings, 500 pins each.
 * @param {TileMember[]} members active pins.
 * @return {SplitResult} shard groups and anything that still does not fit.
 */
export function splitTiles<T extends TileMember>(members: T[]): SplitResult<T> {
  const byG5 = new Map<string, T[]>();
  for (const member of members) {
    const list = byG5.get(member.g5) ?? [];
    list.push(member);
    byG5.set(member.g5, list);
  }
  const groups: ShardGroup<T>[] = [];
  const unassigned: T[] = [];
  const rawOver: string[] = [];
  const warnG5: string[] = [];
  for (const [g5, list] of byG5) {
    list.sort((a, b) => {
      if (a.staticPin !== b.staticPin) return a.staticPin ? -1 : 1;
      if (a.windowEndMs !== b.windowEndMs) return a.windowEndMs - b.windowEndMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (list.length > TILE_CAP) rawOver.push(g5);
    if (list.length >= TILE_WARN_AT) warnG5.push(g5);
    const slots = 1 + MAX_EXTRA_SHARDS;
    for (let shard = 0; shard < slots; shard += 1) {
      const slice = list.slice(shard * TILE_CAP, (shard + 1) * TILE_CAP);
      if (slice.length === 0) break;
      groups.push({g5, shard, members: slice});
    }
    unassigned.push(...list.slice(slots * TILE_CAP));
  }
  rawOver.sort();
  warnG5.sort();
  return {
    groups,
    unassigned,
    rawOver,
    tilesFit: unassigned.length === 0,
    warnG5,
  };
}
