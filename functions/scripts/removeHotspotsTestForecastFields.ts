import {existsSync, readFileSync} from "node:fs";
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
 * Every project source that is set must name the same id as --project:
 * GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, GCP_PROJECT, the project_id in
 * GOOGLE_APPLICATION_CREDENTIALS when that file is readable, FIREBASE_CONFIG
 * projectId, and the initialized app's projectId. A mismatch is refused
 * before any read, and the message names the sources. Outside the emulator,
 * at least one credential or environment source must name a project.
 * With FIRESTORE_EMULATOR_HOST set, --project is still required.
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

const ENV_PROJECT_KEYS = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GCP_PROJECT",
  "google_cloud_project",
  "gcloud_project",
] as const;

export interface ProjectSource {
  name: string;
  projectId: string;
}

function namedProject(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function projectIdFromKeyFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {project_id?: unknown};
    return namedProject(raw.project_id);
  } catch {
    return undefined;
  }
}

function firebaseConfigProjectId(config: string | undefined): string | undefined {
  if (!config) return undefined;
  try {
    const contents = config.startsWith("{") ? config : (existsSync(config) ? readFileSync(config, "utf8") : "");
    if (!contents) return undefined;
    const parsed = JSON.parse(contents) as {projectId?: unknown};
    return namedProject(parsed.projectId);
  } catch {
    return undefined;
  }
}

export function collectProjectSources(env: NodeJS.ProcessEnv): ProjectSource[] {
  const sources: ProjectSource[] = [];
  for (const key of ENV_PROJECT_KEYS) {
    const projectId = namedProject(env[key]);
    if (projectId) sources.push({name: key, projectId});
  }
  if (namedProject(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    const projectId = projectIdFromKeyFile(env.GOOGLE_APPLICATION_CREDENTIALS as string);
    if (projectId) sources.push({name: "GOOGLE_APPLICATION_CREDENTIALS", projectId});
  }
  const firebaseProject = firebaseConfigProjectId(env.FIREBASE_CONFIG);
  if (firebaseProject) sources.push({name: "FIREBASE_CONFIG", projectId: firebaseProject});
  return sources;
}

function refuseMismatchedSources(projectId: string, sources: readonly ProjectSource[], emulator: boolean): void {
  const conflicts = sources.filter((source) => source.projectId !== projectId).map((source) => source.name);
  if (conflicts.length > 0) {
    const verb = conflicts.length === 1 ? "does not match" : "do not match";
    throw new CleanupRefused(`refusing: ${conflicts.join(", ")} ${verb} --project`);
  }
  if (!emulator && sources.length === 0) {
    throw new CleanupRefused("refusing: no credential or environment source names a project");
  }
}

export function planCleanup(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CleanupPlan {
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
  refuseMismatchedSources(projectId, collectProjectSources(env), Boolean(env.FIRESTORE_EMULATOR_HOST));
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
  const plan = planCleanup(argv, env);
  const db = openFirestore(plan.projectId);
  console.log(`project=${plan.projectId} mode=${plan.mode}`);
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
