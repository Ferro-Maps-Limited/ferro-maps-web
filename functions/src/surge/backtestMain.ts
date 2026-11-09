import {readFileSync} from "node:fs";
import {scoreBacktest, type BacktestReport} from "./backtest.js";
import {syntheticBacktestSheet} from "./syntheticSheet.js";

export function parseCsv(text: string): unknown[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === "\"") {
        if (source[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((item) => item.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((item) => item.trim() !== "")) rows.push(row);
  }
  return rows;
}

function reportLine(report: BacktestReport): string {
  const surge = report.predictedYes === 0 ?
    "No surge forecast was made." :
    `${report.surgeYesMatched} of ${report.predictedYes} surge forecasts matched a recorded YES.`;
  const strength = report.strengthCompared === 0 ?
    "No strength comparison." :
    `${report.strengthMatched} of ${report.strengthCompared} strength bands matched the recorded peak band.`;
  return `${report.label}: ${surge} ${strength} Abstained ${report.abstained} of ${report.completed} completed matches.`;
}

export async function main(argv: string[], out: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const args = argv.slice(2);
  try {
    if (args.length === 1 && args[0] === "--synthetic") {
      const sheet = syntheticBacktestSheet();
      const report = scoreBacktest({label: "synthetic", events: sheet.events, readings: sheet.readings});
      out(reportLine(report));
      out(JSON.stringify(report));
      return 0;
    }
    const jsonIndex = args.indexOf("--json");
    if (jsonIndex >= 0 && args[jsonIndex + 1]) {
      const body = JSON.parse(readFileSync(args[jsonIndex + 1], "utf8")) as {events?: unknown[][]; readings?: unknown[][]};
      if (!Array.isArray(body.events) || !Array.isArray(body.readings)) return 1;
      const report = scoreBacktest({label: "private-export", events: body.events, readings: body.readings});
      out(reportLine(report));
      out(JSON.stringify(report));
      return 0;
    }
    const eventsIndex = args.indexOf("--events");
    const readingsIndex = args.indexOf("--readings");
    if (eventsIndex >= 0 && readingsIndex >= 0 && args[eventsIndex + 1] && args[readingsIndex + 1]) {
      const events = parseCsv(readFileSync(args[eventsIndex + 1], "utf8"));
      const readings = parseCsv(readFileSync(args[readingsIndex + 1], "utf8"));
      const report = scoreBacktest({label: "private-export", events, readings});
      out(reportLine(report));
      out(JSON.stringify(report));
      return 0;
    }
  } catch {
    out("backtest failed");
    return 1;
  }
  out("Usage: backtest-stadium-surge --synthetic");
  out("       backtest-stadium-surge --json /path/outside/the/repo/export.json");
  out("       backtest-stadium-surge --events events.csv --readings readings.csv");
  return 2;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("backtestMain.ts") || entry.endsWith("backtestMain.js");
}

if (invokedDirectly()) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 1;
  });
}
