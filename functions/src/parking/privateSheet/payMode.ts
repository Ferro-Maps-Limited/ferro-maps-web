import {type CellWrite, type PrivatePlace} from "./types.js";

export type CellPayMode = "inapp" | "handoff";

/*
 * `inapp` only when `places/{placeId}.payMode` is exactly that string.
 * Anything else, including a missing doc, `handoff`, or `off`, stays handoff.
 */
export function cellPayMode(placeId: string, inAppPlaceIds: ReadonlySet<string>): CellPayMode {
  return inAppPlaceIds.has(placeId) ? "inapp" : "handoff";
}

export function stampPlace(place: PrivatePlace, inAppPlaceIds: ReadonlySet<string>): PrivatePlace {
  return {...place, payMode: cellPayMode(place.id, inAppPlaceIds)};
}

export function stampCells(cells: readonly CellWrite[], inAppPlaceIds: ReadonlySet<string>): CellWrite[] {
  return cells.map((doc) => ({
    ...doc,
    data: {
      ...doc.data,
      places: doc.data.places.map((place) => stampPlace(place, inAppPlaceIds)),
    },
  }));
}

/* One query of places where payMode == inapp. Callers do not getAll every cell place. */
export interface InAppPlaceQuery {
  collection(name: string): {
    where(field: string, op: "==", value: string): {
      select(...fields: string[]): {
        get(): Promise<{docs: Array<{id: string; get(field: string): unknown}>}>;
      };
    };
  };
}

export async function loadInAppPlaceIds(db: InAppPlaceQuery): Promise<Set<string>> {
  const snap = await db.collection("places").where("payMode", "==", "inapp").select("payMode").get();
  const ids = new Set<string>();
  for (const doc of snap.docs) {
    if (doc.get("payMode") === "inapp") ids.add(doc.id);
  }
  return ids;
}
