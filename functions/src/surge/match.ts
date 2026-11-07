/*
 * Operational linking is held. Metre bands and venue publication are not
 * approved. Proximity is not occurrence. A missing candidate count is not 1.
 * This module does not publish.
 */

export type LinkClass = "confirmed" | "venue" | "eventOnly" | "airportName" | "review" | "none";

export type PickupKind = "entrance" | "station" | "other";

export interface TimeWindow {
  start: Date;
  end: Date;
}

export interface PickupDistance {
  kind: PickupKind;
  distanceM: number;
  sameKind: boolean;
}

export interface LinkDecision {
  linkClass: LinkClass | null;
  publishable: false;
  held: boolean;
}

export function windowsOverlap(pin: TimeWindow | null, event: TimeWindow | null): boolean {
  if (pin == null || event == null) return false;
  const pinStart = pin.start.getTime();
  const pinEnd = pin.end.getTime();
  const eventStart = event.start.getTime();
  const eventEnd = event.end.getTime();
  if (![pinStart, pinEnd, eventStart, eventEnd].every(Number.isFinite)) return false;
  if (pinEnd <= pinStart || eventEnd <= eventStart) return false;
  return pinStart <= eventEnd && eventStart <= pinEnd;
}

export function linkIsPublishable(linkClass: LinkClass | null): false {
  void linkClass;
  return false;
}

export function classifyLink(input: {
  pinWindow: TimeWindow | null;
  eventWindow: TimeWindow | null;
  candidateCount: number | undefined;
  pickups: PickupDistance[];
}): LinkDecision {
  void input.pickups;
  if (!Number.isInteger(input.candidateCount) || (input.candidateCount ?? 0) < 1) {
    return {linkClass: null, publishable: false, held: true};
  }
  if (!windowsOverlap(input.pinWindow, input.eventWindow)) {
    return {linkClass: "none", publishable: false, held: false};
  }
  return {linkClass: null, publishable: false, held: true};
}
