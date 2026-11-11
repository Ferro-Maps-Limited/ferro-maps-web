import {existsSync, readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {cert, getApp, getApps, initializeApp} from "firebase-admin/app";
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
 * Outside the emulator, GOOGLE_APPLICATION_CREDENTIALS must point at a
 * readable JSON file with a non-empty project_id. Plain gcloud login is
 * not accepted. A file or FIREBASE_CONFIG that is missing, unreadable,
 * not valid JSON, or missing its project field is refused, including on
 * the emulator when that variable is set. Every project source that is
 * set must still match --project. Refusal happens before any read and
 * before app initialisation, and the message names the source only.
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

type FileProblem = "missing" | "unreadable" | "malformed" | "no-project";

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readJsonObject(path: string): {ok: true; value: Record<string, unknown>} | {ok: false; problem: FileProblem} {
  if (!existsSync(path)) return {ok: false, problem: "missing"};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {ok: false, problem: "unreadable"};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {ok: false, problem: "malformed"};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {ok: false, problem: "malformed"};
  return {ok: true, value: parsed as Record<string, unknown>};
}

function credentialRefusal(problem: FileProblem): string {
  if (problem === "missing") return "refusing: GOOGLE_APPLICATION_CREDENTIALS file is missing";
  if (problem === "unreadable") return "refusing: GOOGLE_APPLICATION_CREDENTIALS file is unreadable";
  if (problem === "malformed") return "refusing: GOOGLE_APPLICATION_CREDENTIALS file is not valid JSON";
  return "refusing: GOOGLE_APPLICATION_CREDENTIALS file has no project_id";
}

function firebaseRefusal(problem: FileProblem): string {
  if (problem === "missing") return "refusing: FIREBASE_CONFIG file is missing";
  if (problem === "unreadable") return "refusing: FIREBASE_CONFIG file is unreadable";
  if (problem === "malformed") return "refusing: FIREBASE_CONFIG is not valid JSON";
  return "refusing: FIREBASE_CONFIG has no projectId";
}

function firebaseProject(config: string): {ok: true; projectId: string} | {ok: false; problem: FileProblem} {
  if (config.trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config);
    } catch {
      return {ok: false, problem: "malformed"};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {ok: false, problem: "malformed"};
    const projectId = nonEmpty((parsed as {projectId?: unknown}).projectId);
    return projectId ? {ok: true, projectId} : {ok: false, problem: "no-project"};
  }
  const file = readJsonObject(config);
  if (!file.ok) return file;
  const projectId = nonEmpty(file.value.projectId);
  return projectId ? {ok: true, projectId} : {ok: false, problem: "no-project"};
}

export function collectProjectSources(env: NodeJS.ProcessEnv, emulator: boolean): ProjectSource[] {
  const sources: ProjectSource[] = [];
  for (const key of ENV_PROJECT_KEYS) {
    const projectId = nonEmpty(env[key]);
    if (projectId) sources.push({name: key, projectId});
  }
  const credentialPath = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!credentialPath) {
    if (!emulator) throw new CleanupRefused("refusing: GOOGLE_APPLICATION_CREDENTIALS is required");
  } else {
    const file = readJsonObject(credentialPath);
    if (!file.ok) throw new CleanupRefused(credentialRefusal(file.problem));
    const projectId = nonEmpty(file.value.project_id);
    if (!projectId) throw new CleanupRefused(credentialRefusal("no-project"));
    sources.push({name: "GOOGLE_APPLICATION_CREDENTIALS", projectId});
  }
  const firebaseConfig = nonEmpty(env.FIREBASE_CONFIG);
  if (firebaseConfig) {
    const firebase = firebaseProject(firebaseConfig);
    if (!firebase.ok) throw new CleanupRefused(firebaseRefusal(firebase.problem));
    sources.push({name: "FIREBASE_CONFIG", projectId: firebase.projectId});
  }
  return sources;
}

function refuseMismatchedSources(projectId: string, sources: readonly ProjectSource[]): void {
  const conflicts = sources.filter((source) => source.projectId !== projectId).map((source) => source.name);
  if (conflicts.length === 0) return;
  const verb = conflicts.length === 1 ? "does not match" : "do not match";
  throw new CleanupRefused(`refusing: ${conflicts.join(", ")} ${verb} --project`);
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
  const emulator = Boolean(env.FIRESTORE_EMULATOR_HOST);
  refuseMismatchedSources(projectId, collectProjectSources(env, emulator));
  const mode = apply.present ? "apply" : "dry run";
  return {projectId, apply: apply.present, pageSize: readPageSize(argv), mode};
}

function openFirestore(projectId: string, env: NodeJS.ProcessEnv): Firestore {
  const emulator = Boolean(env.FIRESTORE_EMULATOR_HOST);
  const hasDefault = getApps().some((app) => app.name === "[DEFAULT]");
  if (!hasDefault) {
    if (emulator) {
      initializeApp({projectId});
    } else {
      const credentialPath = nonEmpty(env.GOOGLE_APPLICATION_CREDENTIALS);
      if (!credentialPath) throw new CleanupRefused("refusing: GOOGLE_APPLICATION_CREDENTIALS is required");
      try {
        initializeApp({credential: cert(credentialPath), projectId});
      } catch (err) {
        if (err instanceof CleanupRefused) throw err;
        throw new CleanupRefused("refusing: GOOGLE_APPLICATION_CREDENTIALS file cannot be used as a credential");
      }
    }
  }
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
  const db = openFirestore(plan.projectId, env);
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
