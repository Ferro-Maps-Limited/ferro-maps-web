import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {buildImport, notImportedCsv, notImportedRows, summarise, type DryRunSummary} from "./src/build.ts";
import {readSheet, SHEET_NAME} from "./src/readSheet.ts";
import {type CellWrite, type SourceRow} from "./src/types.ts";

export interface CliArgs {
  write: boolean;
  project: string;
  input: string;
  summary: string;
  sheet: string;
  now: string;
  help: boolean;
}

const DEFAULT_SUMMARY = path.join(path.dirname(fileURLToPath(import.meta.url)), "output", "dry-run-summary.json");

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    write: false,
    project: "",
    input: "",
    summary: DEFAULT_SUMMARY,
    sheet: SHEET_NAME,
    now: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      i += 1;
      return value;
    };
    if (token === "--write") args.write = true;
    else if (token === "--project") args.project = next();
    else if (token === "--input") args.input = next();
    else if (token === "--summary") args.summary = next();
    else if (token === "--sheet") args.sheet = next();
    else if (token === "--now") args.now = next();
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return args;
}

export const HELP = `Import private parking rows into privateParkingCells.

Dry-run is the default and writes nothing to Firestore.
Pass both --write and --project <id> to upsert. Either flag alone does not write.

  --input <xlsx>     Workbook path
  --sheet <name>     Default: ${SHEET_NAME}
  --summary <json>   Dry-run summary path
  --now <iso>        Clock for generatedAt / expiresAt
  --write            Required together with --project
  --project <id>     Firebase project id. Ignored unless --write is set.
`;

export interface RunIO {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  read?: (file: string, sheet: string) => Promise<SourceRow[]>;
  writeCells?: (projectId: string, docs: CellWrite[]) => Promise<void>;
  writeSummary?: (file: string, summary: DryRunSummary) => Promise<void>;
  writeNotImported?: (file: string, csv: string) => Promise<void>;
}

async function defaultWriteSummary(file: string, summary: DryRunSummary): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);
}

export function notImportedPath(summaryPath: string): string {
  return path.join(path.dirname(summaryPath), "not-imported.csv");
}

/**
 * Real writer. Not used by the dry-run. Refuses unless a project id was passed.
 * firebase-admin is imported only on this path.
 */
async function loadModule(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

export async function writeCells(projectId: string, docs: CellWrite[]): Promise<void> {
  if (!projectId) throw new Error("refusing to write without --project. Nothing was written.");
  const app = await loadModule("firebase-admin/app");
  const firestore = await loadModule("firebase-admin/firestore");
  const getApps = app.getApps as () => unknown[];
  const initializeApp = app.initializeApp as (options: {projectId: string}) => unknown;
  const application = getApps()[0] ?? initializeApp({projectId});
  const getFirestore = firestore.getFirestore as (application: unknown) => {
    batch: () => {
      set: (ref: unknown, data: unknown) => void;
      commit: () => Promise<void>;
    };
    collection: (name: string) => {doc: (id: string) => unknown};
  };
  const Timestamp = firestore.Timestamp as {fromDate: (date: Date) => unknown};
  const db = getFirestore(application);
  let batch = db.batch();
  let pending = 0;
  for (const doc of docs) {
    const ref = db.collection("privateParkingCells").doc(doc.id);
    const data = {
      ...doc.data,
      generatedAt: Timestamp.fromDate(new Date(doc.data.generatedAt)),
      expiresAt: Timestamp.fromDate(new Date(doc.data.expiresAt)),
      places: doc.data.places.map((place) => {
        const copy: Record<string, unknown> = {...place};
        if (typeof place.capturedAt === "string") copy.capturedAt = Timestamp.fromDate(new Date(place.capturedAt));
        if (typeof place.verifiedAt === "string") copy.verifiedAt = Timestamp.fromDate(new Date(place.verifiedAt));
        return copy;
      }),
    };
    batch.set(ref, data);
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();
}

export async function run(argv: string[], io: RunIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr("Nothing was written.");
    return 2;
  }
  if (args.help) {
    stdout(HELP);
    return 0;
  }
  if (args.write && !args.project) {
    stderr("refusing to write: --write requires --project <id>. Nothing was written.");
    return 2;
  }
  if (!args.write && args.project) {
    stderr("--project is ignored without --write. Nothing was written.");
  }
  if (!args.input) {
    stderr("refusing to run: --input is required. Nothing was written.");
    return 2;
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    stderr("refusing to run: --now is not a time. Nothing was written.");
    return 2;
  }
  try {
    const read = io.read ?? readSheet;
    const rows = await read(args.input, args.sheet);
    const build = buildImport(rows, now);
    const summary = summarise(build, args.sheet);
    if (!args.write) {
      const writeSummary = io.writeSummary ?? defaultWriteSummary;
      await writeSummary(args.summary, summary);
      const csvPath = notImportedPath(args.summary);
      const csv = notImportedCsv(notImportedRows(rows, build));
      const writeNotImported = io.writeNotImported ?? (async (file, body) => {
        await mkdir(path.dirname(file), {recursive: true});
        await writeFile(file, body);
      });
      await writeNotImported(csvPath, csv);
      stdout(JSON.stringify({
        wroteToFirestore: false,
        totalRows: summary.totalRows,
        dataRows: summary.dataRows,
        skipped: summary.skipped,
        imported: summary.imported,
        verified: summary.verified,
        verifiedSourceRows: summary.verifiedSourceRows,
        approx: summary.approx,
        aud: summary.aud,
        srcType: summary.srcType,
        locationCode: summary.locationCode,
        cells: summary.cells,
        shards: summary.shards,
        duplicatesMerged: summary.duplicatesMerged,
        summary: args.summary,
        notImported: csvPath,
      }, null, 2));
      return 0;
    }
    const writer = io.writeCells ?? writeCells;
    await writer(args.project, build.cells);
    stdout(`wrote ${build.cells.length} privateParkingCells documents to ${args.project}`);
    return 0;
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    stderr(args.write ? "write failed." : "Nothing was written.");
    return 1;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
