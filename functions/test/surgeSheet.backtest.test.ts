import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, it} from "node:test";
import {scoreBacktest} from "../src/surge/backtest";
import {main, parseCsv} from "../src/surge/backtestMain";
import {syntheticBacktestSheet, SYNTHETIC_PRICE_TOKENS} from "../src/surge/syntheticSheet";

describe("surge sheet backtest", () => {
  it("scores synthetic history by kick-off and prints no fares", async () => {
    const sheet = syntheticBacktestSheet();
    const report = scoreBacktest({label: "synthetic", events: sheet.events, readings: sheet.readings});
    assert.deepEqual(report, {
      label: "synthetic",
      completed: 6,
      predictedYes: 2,
      abstained: 4,
      surgeYesMatched: 1,
      surgeYesMissed: 1,
      strengthCompared: 1,
      strengthMatched: 1,
    });
    const lines: string[] = [];
    const code = await main(["node", "backtestMain.ts", "--synthetic"], (line) => lines.push(line));
    assert.equal(code, 0);
    const printed = lines.join("\n");
    for (const token of SYNTHETIC_PRICE_TOKENS) assert.equal(printed.includes(token), false, token);
    const dir = mkdtempSync(join(tmpdir(), "surge-backtest-"));
    const jsonPath = join(dir, "export.json");
    writeFileSync(jsonPath, JSON.stringify(sheet));
    const fromJson: string[] = [];
    const jsonCode = await main(["node", "backtestMain.ts", "--json", jsonPath], (line) => fromJson.push(line));
    assert.equal(jsonCode, 0);
    assert.match(fromJson[0], /private-export/);
    const eventsPath = join(dir, "events.csv");
    const readingsPath = join(dir, "readings.csv");
    writeFileSync(eventsPath, "Event ID,Ground\n2099-03-01-SYN-ZZZ,\"Synthetic Park\"\n");
    writeFileSync(readingsPath, "Time (UK),Event ID\n");
    const parsed = parseCsv(readFileSync(eventsPath, "utf8"));
    assert.equal(parsed[1][1], "Synthetic Park");
    const csvCode = await main(
      ["node", "backtestMain.ts", "--events", eventsPath, "--readings", readingsPath],
      () => undefined,
    );
    assert.equal(csvCode, 0);
  });
});
