/*
 * §21.3 class table. Occurrence and identity are inputs: this function does
 * not decide them from sheet columns. Only `confirmed` and `venue` are
 * publishable, and only after the gate. This module does not publish.
 */

export type LinkClass = "confirmed" | "venue" | "eventOnly" | "airportName" | "review" | "none";

export type PickupKind = "entrance" | "station" | "other";

export interface PickupDistance {
  kind: PickupKind;
  distanceM: number;
  sameKind: boolean;
}

export const CONFIRMED_METRES = 100;
export const VENUE_METRES = 300;
export const REVIEW_METRES = 500;

export function linkIsPublishable(linkClass: LinkClass): boolean {
  return linkClass === "confirmed" || linkClass === "venue";
}

export function classifyLink(input: {
  occurrenceOverlap: boolean;
  identityMatch: boolean;
  contradicted: boolean;
  categoryMismatch: boolean;
  candidateCount: number;
  airportWithoutCoordinates: boolean;
  pickups: PickupDistance[];
}): LinkClass {
  if (input.contradicted) return "none";
  if (input.airportWithoutCoordinates) return "airportName";
  if (input.candidateCount > 1 || input.categoryMismatch) return "review";
  const identified = input.occurrenceOverlap && input.identityMatch;
  const sameKindClose = input.pickups.some((pickup) => {
    return pickup.sameKind && pickup.distanceM <= CONFIRMED_METRES;
  });
  const entranceVenue = input.pickups.some((pickup) => {
    return pickup.kind === "entrance" &&
      pickup.distanceM > CONFIRMED_METRES &&
      pickup.distanceM <= VENUE_METRES;
  });
  if (identified && sameKindClose) return "confirmed";
  if (identified && entranceVenue) return "venue";
  if (identified) return "eventOnly";
  const near = input.pickups.some((pickup) => pickup.distanceM <= REVIEW_METRES);
  if (near) return "review";
  return "none";
}
