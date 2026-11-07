export interface DesiredPlaceIndex {
  placeId: string;
  cellId: string;
}

export interface ExistingPlaceIndex {
  placeId: string;
  cellId?: string;
}

export interface PlaceIndexWrite {
  placeId: string;
  action: "upsert" | "delete";
  cellId?: string;
}

/* One row per place. A duplicate id keeps the lexicographically smaller cell id. */
export function desiredPlaceIndex(
  cells: ReadonlyArray<{data: {cell: string; places: ReadonlyArray<{id: string}>}}>,
): DesiredPlaceIndex[] {
  const next = new Map<string, string>();
  for (const doc of cells) {
    const cellId = doc.data.cell;
    if (!cellId) continue;
    for (const place of doc.data.places) {
      if (!place.id) continue;
      const prev = next.get(place.id);
      if (prev === undefined || cellId < prev) next.set(place.id, cellId);
    }
  }
  return [...next.entries()]
    .map(([placeId, cellId]) => ({placeId, cellId}))
    .sort((a, b) => a.placeId.localeCompare(b.placeId));
}

/*
 * Diff the live places against parkingPlaceIndex.
 * Create a missing id, rewrite when cellId changes, delete an id that is gone.
 * The same cellId is not a write, so updatedAt stays put.
 */
export function planParkingPlaceIndex(input: {
  desired: readonly DesiredPlaceIndex[];
  existing: readonly ExistingPlaceIndex[];
}): PlaceIndexWrite[] {
  const next = new Map<string, string>();
  for (const row of input.desired) next.set(row.placeId, row.cellId);
  const seen = new Set<string>();
  const writes: PlaceIndexWrite[] = [];
  for (const doc of input.existing) {
    seen.add(doc.placeId);
    const cellId = next.get(doc.placeId);
    if (cellId === undefined) {
      writes.push({placeId: doc.placeId, action: "delete"});
    } else if (doc.cellId !== cellId) {
      writes.push({placeId: doc.placeId, action: "upsert", cellId});
    }
  }
  for (const [placeId, cellId] of next) {
    if (!seen.has(placeId)) writes.push({placeId, action: "upsert", cellId});
  }
  writes.sort((a, b) => a.placeId.localeCompare(b.placeId) || a.action.localeCompare(b.action));
  return writes;
}
