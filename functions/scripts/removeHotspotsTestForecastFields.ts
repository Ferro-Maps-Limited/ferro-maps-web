import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {initializeApp, getApps, getApp} from "firebase-admin/app";
import {
  FieldPath,
  FieldValue,
  getFirestore,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import {HOTSPOTS_COLLECTION} from "../src/surge/collections.js";

/*
 * One-time removal of forecast fields from hotspots_test.
 * Dry run unless --apply names the same project as --project.
 * Counts only. No prices. No document deletes.
 *
 *   --project <id>            required
 *   --apply=<id>              or: --apply --confirm-project <id>
 *   --page-size <n>           default 300
 *
 * Outside the emulator, <id> must match the credential project
 * (GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or the key file's project_id)
 * and the app projectId. With FIRESTORE_EMULATOR_HOST set, the script
 * may run against that emulator project, and it still requires --project.
 *
 * The pin keeps window_start, window_end, expire_at, removeBy, and surgeEnded.
 * Those are how the map shows and drops a pin. The forecast itself lives on
 * hotspot_forecasts.
 */
export const HOTSPOTS_TEST_FORECAST_FIELDS = [
  "forecast",
  "forecastHistory",
  "forecastSource",
  "forecastUpdatedAt",
] as const;

export const DEFAULT_PAGE_SIZE = 300;
const MAX_PAGE_SIZE = 1000;
const BATCH_LIMIT = 400;

export class CleanupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupRefused";
  }
}

export interface ForecastFieldRemoval {
  scanned: number;
  changed: number;
  apply: boolean;
  pages: number;
}

export interface CleanupPlan {
  projectId: string;
  apply: boolean;
  pageSize: number;
  mode: "dry run" | "apply";
}

function hasForecastField(data: Record<string, unknown>): boolean {
  return HOTSPOTS_TEST_FORECAST_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(data, key));
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const eq = argv.find((arg) => arg.startsWith(prefix));
  const raw = eq ? eq.slice(prefix.length) : undefined;
  if (raw !== undefined) return raw === "" ? undefined : raw;
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function readApply(argv: readonly string[]): {present: boolean; named?: string} {
  const prefix = "--apply=";
  const eq = argv.find((arg) => arg.startsWith(prefix));
  if (eq) {
    const named = eq.slice(prefix.length);
    return {present: true, named: named === "" ? undefined : named};
  }
  const index = argv.indexOf("--apply");
  if (index < 0) return {present: false};
  const next = argv[index + 1];
  if (next && !next.startsWith("--")) return {present: true, named: next};
  return {present: true};
}

function readPageSize(argv: readonly string[]): number {
  const raw = flagValue(argv, "--page-size");
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new CleanupRefused("refusing: --page-size must be a positive integer");
  }
  const pageSize = Number(raw);
  if (pageSize > MAX_PAGE_SIZE) {
    throw new CleanupRefused("refusing: --page-size must be 1000 or less");
  }
  return pageSize;
}

function projectIdFromKeyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {project_id?: unknown};
    return typeof raw.project_id === "string" && raw.project_id ? raw.project_id : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCredentialProjectId(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.GCLOUD_PROJECT ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.gcloud_project ||
    env.google_cloud_project;
  if (typeof fromEnv === "string" && fromEnv) return fromEnv;
  if (typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string" && env.GOOGLE_APPLICATION_CREDENTIALS) {
    return projectIdFromKeyFile(env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  const configHome = env.CLOUDSDK_CONFIG ||
    (env.HOME ? join(env.HOME, ".config", "gcloud") : undefined) ||
    (env.USERPROFILE ? join(env.USERPROFILE, ".config", "gcloud") : undefined);
  if (!configHome) return undefined;
  return projectIdFromKeyFile(join(configHome, "application_default_credentials.json"));
}

export function planCleanup(argv: readonly string[], env: {
  emulatorHost?: string;
  resolvedProjectId?: string;
} = {}): CleanupPlan {
  const projectId = flagValue(argv, "--project");
  if (!projectId) throw new CleanupRefused("refusing: --project is required");
  const apply = readApply(argv);
  if (apply.present) {
    const confirm = flagValue(argv, "--confirm-project");
    const names = [apply.named, confirm].filter((name): name is string => Boolean(name));
    if (names.length === 0) {
      throw new CleanupRefused("refusing: --apply must name the project");
    }
    if (names.some((name) => name !== projectId)) {
      throw new CleanupRefused("refusing: --apply project does not match --project");
    }
  }
  if (!env.emulatorHost) {
    if (!env.resolvedProjectId) {
      throw new CleanupRefused("refusing: credentials do not resolve to a project");
    }
    if (env.resolvedProjectId !== projectId) {
      throw new CleanupRefused("refusing: --project does not match the credentials");
    }
  }
  const mode = apply.present ? "apply" : "dry run";
  return {projectId, apply: apply.present, pageSize: readPageSize(argv), mode};
}

function openFirestore(projectId: string): Firestore {
  const hasDefault = getApps().some((app) => app.name === "[DEFAULT]");
  if (!hasDefault) initializeApp({projectId});
  const app = getApp();
  if (app.options.projectId !== projectId) {
    throw new CleanupRefused("refusing: app projectId does not match --project");
  }
  return getFirestore(app);
}

export async function runCleanup(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ForecastFieldRemoval> {
  const plan = planCleanup(argv, {
    emulatorHost: env.FIRESTORE_EMULATOR_HOST,
    resolvedProjectId: resolveCredentialProjectId(env),
  });
  console.log(`project=${plan.projectId} mode=${plan.mode}`);
  const db = openFirestore(plan.projectId);
  return removeHotspotsTestForecastFields(db, plan.apply, plan.pageSize);
}

export async function removeHotspotsTestForecastFields(
  db: Firestore,
  apply: boolean,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<ForecastFieldRemoval> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new CleanupRefused("refusing: page size must be a positive integer");
  }
  const patch: Record<string, FirebaseFirestore.FieldValue> = {};
  for (const key of HOTSPOTS_TEST_FORECAST_FIELDS) patch[key] = FieldValue.delete();
  let scanned = 0;
  let changed = 0;
  let pages = 0;
  let last: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query: Query = db.collection(HOTSPOTS_COLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    pages += 1;
    scanned += snap.size;
    last = snap.docs[snap.docs.length - 1];
    let batch = db.batch();
    let pending = 0;
    for (const doc of snap.docs) {
      if (!hasForecastField(doc.data())) continue;
      changed += 1;
      if (!apply) continue;
      batch.update(doc.ref, patch);
      pending += 1;
      if (pending === BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (apply && pending > 0) await batch.commit();
    if (snap.size < pageSize) break;
  }
  return {scanned, changed, apply, pages};
}

async function main(): Promise<void> {
  const result = await runCleanup(process.argv);
  console.log(JSON.stringify({
    apply: result.apply,
    scanned: result.scanned,
    changed: result.changed,
  }));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((err: unknown) => {
    if (err instanceof CleanupRefused) console.error(err.message);
    else console.error(err instanceof Error ? err.name : "Error");
    process.exitCode = 1;
  });
}
