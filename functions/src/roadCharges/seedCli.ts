import {BANK_HOLIDAYS_URL, bankHolidaysFromGovUk} from "./bankHolidays.js";
import type {RoadChargeConfig} from "./config.js";
import {exampleSeedPayload} from "./exampleConfig.js";

export interface SeedDocs {
  cc: RoadChargeConfig;
  ulez: RoadChargeConfig;
}

export interface SeedDeps {
  fetch?: typeof fetch;
  write?: (docs: SeedDocs, projectId: string) => Promise<void>;
}

export interface SeedCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function projectFrom(argv: string[]): string | null {
  const flag = argv.indexOf("--project");
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1];
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
}

async function loadBankHolidays(fetchImpl: typeof fetch): Promise<string[]> {
  const response = await fetchImpl(BANK_HOLIDAYS_URL);
  if (!response.ok) throw new Error(`bank holidays HTTP ${response.status}`);
  return bankHolidaysFromGovUk(await response.json());
}

async function defaultWrite(docs: SeedDocs, projectId: string): Promise<void> {
  const appMod = await import("firebase-admin/app");
  const firestoreMod = await import("firebase-admin/firestore");
  if (appMod.getApps().length === 0) appMod.initializeApp({projectId});
  const db = firestoreMod.getFirestore();
  const batch = db.batch();
  batch.set(db.doc("roadCharges/cc"), docs.cc);
  batch.set(db.doc("roadCharges/ulez"), docs.ulez);
  await batch.commit();
}

// Dry run unless --write is passed. --write is what a staging deploy needs
// before the reminder job will send. This function does not call Firestore
// unless --write is set and no injected writer is given.
export async function runSeedCli(argv: string[], deps: SeedDeps = {}): Promise<SeedCliResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      exitCode: 0,
      stdout: "Usage: npm run seed:road-charges [-- --write --project <id>]\n" +
        "Prints roadCharges/cc and roadCharges/ulez. Default is a dry run.\n" +
        "bankHolidays comes from https://www.gov.uk/bank-holidays.json (england-and-wales).\n",
      stderr: "",
    };
  }
  let bankHolidays: string[];
  try {
    bankHolidays = await loadBankHolidays(deps.fetch ?? fetch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {exitCode: 1, stdout: "", stderr: `${message}\n`};
  }
  const wantsWrite = argv.includes("--write");
  if (!wantsWrite) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(exampleSeedPayload(bankHolidays, false), null, 2)}\n`,
      stderr: "",
    };
  }
  const payload = exampleSeedPayload(bankHolidays, true);
  const documents = payload.documents as Record<string, RoadChargeConfig>;
  const docs: SeedDocs = {
    cc: documents["roadCharges/cc"],
    ulez: documents["roadCharges/ulez"],
  };
  const injected = deps.fetch != null || deps.write != null;
  if (injected && !deps.write) {
    return {exitCode: 2, stdout: "", stderr: "--write was not confirmed. Nothing was written.\n"};
  }
  const projectId = projectFrom(argv);
  if (!projectId) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "--write needs --project or GCLOUD_PROJECT. Nothing was written.\n",
    };
  }
  try {
    if (deps.write) await deps.write(docs, projectId);
    else await defaultWrite(docs, projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {exitCode: 1, stdout: "", stderr: `${message}\n`};
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({dryRun: false, wrote: true, project: projectId}, null, 2)}\n`,
    stderr: "",
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("/seedCli.ts") || entry.endsWith("/seedCli.js") ||
    entry.endsWith("\\seedCli.ts") || entry.endsWith("\\seedCli.js");
}

if (isDirectRun()) {
  runSeedCli(process.argv.slice(2)).then((result) => {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode);
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
