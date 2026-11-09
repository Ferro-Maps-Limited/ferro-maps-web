import {strengthBand, type Band} from "./thresholds.js";
import {parseSurgeSheet} from "./parse.js";
import {planStadiumEvents} from "./plan.js";

export interface BacktestReport {
  label: string;
  completed: number;
  predictedYes: number;
  abstained: number;
  surgeYesMatched: number;
  surgeYesMissed: number;
  strengthCompared: number;
  strengthMatched: number;
}

/*
 * Walk forward by kick-off. Each completed match is scored from earlier matches only.
 * A no_prediction row is an abstention, not a miss. Strength is compared only when
 * the match itself was YES and its peak uplift falls in a band.
 * The report is counts. It does not include fares or uplift figures.
 */
export function scoreBacktest(input: {
  label: string;
  events: unknown[][];
  readings: unknown[][];
  now?: Date;
}): BacktestReport {
  const parsed = parseSurgeSheet(input.events, input.readings);
  const planned = planStadiumEvents({
    now: input.now ?? new Date("2099-01-01T00:00:00.000Z"),
    events: input.events,
    readings: input.readings,
  });
  const byId = new Map(parsed.events.map((event) => [event.sheetEventId, event]));
  const report: BacktestReport = {
    label: input.label,
    completed: 0,
    predictedYes: 0,
    abstained: 0,
    surgeYesMatched: 0,
    surgeYesMissed: 0,
    strengthCompared: 0,
    strengthMatched: 0,
  };
  for (const record of planned.records) {
    const source = byId.get(record.sheetEventId);
    if (!source || (source.outcome !== "yes" && source.outcome !== "no")) continue;
    report.completed += 1;
    if (record.forecast.state !== "available") {
      report.abstained += 1;
      continue;
    }
    report.predictedYes += 1;
    if (source.outcome === "yes") report.surgeYesMatched += 1;
    else report.surgeYesMissed += 1;
    if (source.outcome === "yes" && source.peakUplift != null) {
      const actual: Band | null = strengthBand(source.peakUplift);
      if (actual) {
        report.strengthCompared += 1;
        if (actual === record.forecast.strength) report.strengthMatched += 1;
      }
    }
  }
  return report;
}
