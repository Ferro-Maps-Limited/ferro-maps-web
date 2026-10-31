const test = require("node:test");
const assert = require("node:assert/strict");
const {spawnSync} = require("child_process");
const path = require("path");
const {initializeApp, getApps} = require("firebase-admin/app");
const {getFirestore, GeoPoint, Timestamp, FieldPath} = require("firebase-admin/firestore");

const PROJECT = "demo-ferromaps-readonly";
const ROOT = path.join(__dirname, "../..");
const COMBINED = path.join(ROOT, "scripts/pins-dryrun-combined.js");
const APPVERSION = path.join(ROOT, "scripts/check-appversion-length.js");
const SECRET = "V".repeat(40);
const EMAIL = "pii-email-sentinel@example.com";

if (getApps().length === 0) {
  initializeApp({projectId: PROJECT});
}
const db = getFirestore();

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: process.env,
  });
}

async function clearProject() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  const resp = await fetch(
      `http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      {method: "DELETE"},
  );
  if (!resp.ok) throw new Error(await resp.text());
}

async function seedSmall() {
  const now = new Date();
  const later = Timestamp.fromDate(new Date(now.getTime() + 3 * 60 * 60 * 1000));
  const sooner = Timestamp.fromDate(new Date(now.getTime() + 60 * 60 * 1000));
  await db.collection("hotspots_test").doc("park-live").set({
    name: "Live bay",
    category: "parking",
    country: "PII-COUNTRY-SENTINEL",
    location: new GeoPoint(51.5, -0.12),
    expire_at: Timestamp.fromDate(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)),
  });
  await db.collection("hotspots_test").doc("event-live").set({
    name: "Live match",
    category: "events",
    country: "PII-COUNTRY-SENTINEL",
    location: new GeoPoint(51.51, -0.13),
    window_start: sooner,
    window_end: later,
  });
  await db.collection("pins").doc("already-there").set({
    g5: "gcpvj",
    src: "live",
    category: "event",
    window_end: later,
    name: "PII-PIN-NAME-SENTINEL",
  });
  await db.collection("users").doc("driver-long").set({
    name: "PII-NAME-SENTINEL",
    email: EMAIL,
    appVersion: SECRET,
  });
  await db.collection("users").doc("driver-ok").set({
    name: "Short",
    appVersion: "1.2.3",
  });
  await db.collection("deviceSessionRequests").doc("sess-long").set({
    appVersion: SECRET,
    status: "pending",
  });
  await db.collection("subscriptionRequests").doc("sub-ok").set({
    appVersion: "2.0.0",
    status: "pending",
  });
  await db.collection("accountDeletionRequests").doc("del-long").set({
    appVersion: "D".repeat(33),
    status: "pending",
  });
  await db.collection("contributionRequests").doc("con-long").set({
    appVersion: "C".repeat(36),
    status: "pending",
  });
  await db.collection("parkingPaymentRequests").doc("pay-long").set({
    appVersion: "P".repeat(34),
    status: "pending",
  });
}

test("combined dry run is read-only and reports sources", async () => {
  await clearProject();
  await seedSmall();
  const before = await db.collection("pins").count().get();
  const result = run(COMBINED, ["--project", PROJECT]);
  const after = await db.collection("pins").count().get();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(after.data().count, before.data().count);
  const lines = result.stdout.split("\n");
  assert.equal(lines[0], `project: ${PROJECT}`);
  assert.match(result.stdout, /static: \d+ active of 3968 seed docs/);
  assert.match(result.stdout, /parking: 1/);
  assert.match(result.stdout, /event: 1/);
  assert.match(result.stdout, /existing: 1/);
  assert.match(result.stdout, /tilesOver500Before: 0/);
  assert.match(result.stdout, /tilesOver500After: 0/);
  assert.match(result.stdout, /gcpvj total=\d+ static=\d+ parking=0 event=1 existing=1 other=0/);
  assert.equal(result.stdout.includes("PII-COUNTRY-SENTINEL"), false);
  assert.equal(result.stdout.includes("PII-PIN-NAME-SENTINEL"), false);
  assert.match(result.stdout, /No documents were written/);
});

test("combined dry run exits non-zero when a tile still exceeds 500 after the split", async () => {
  await clearProject();
  const later = Timestamp.fromDate(new Date(Date.now() + 3 * 60 * 60 * 1000));
  const total = 500 * 9 + 1;
  for (let i = 0; i < total; i += 400) {
    const batch = db.batch();
    const end = Math.min(i + 400, total);
    for (let n = i; n < end; n += 1) {
      batch.set(db.collection("pins").doc(`overflow_${n}`), {
        g5: "zzzzz",
        src: "live",
        category: "event",
        window_end: later,
      });
    }
    await batch.commit();
  }
  const result = run(COMBINED, ["--project", PROJECT]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /tilesOver500Before: [1-9]/);
  assert.match(result.stdout, /tilesOver500After: [1-9]/);
  assert.match(result.stdout, /^project: /m);
});

test("combined dry run refuses a write flag and does not query", async () => {
  const result = run(COMBINED, ["--project", PROJECT, "--write"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /write flag/);
  assert.equal(result.stdout.includes(`project: ${PROJECT}`), false);
});

test("appVersion length check counts long values without printing them", async () => {
  await clearProject();
  await seedSmall();
  const result = run(APPVERSION, ["--project", PROJECT]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.equal(lines[0], `project: ${PROJECT}`);
  assert.match(result.stdout, /users: 1\n {2}driver-long length=40/);
  assert.match(result.stdout, /deviceSessionRequests: 1\n {2}sess-long length=40/);
  assert.match(result.stdout, /subscriptionRequests: 0/);
  assert.match(result.stdout, /accountDeletionRequests: 1\n {2}del-long length=33/);
  assert.match(result.stdout, /contributionRequests: 1\n {2}con-long length=36/);
  assert.match(result.stdout, /parkingPaymentRequests: 1\n {2}pay-long length=34/);
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stdout.includes(EMAIL), false);
  assert.equal(result.stdout.includes("PII-NAME-SENTINEL"), false);
  assert.match(result.stdout, /No documents were written/);
  const ids = await db.collection("users").orderBy(FieldPath.documentId()).select("appVersion").get();
  assert.equal(ids.size, 2);
});

test("appVersion check refuses a write flag", async () => {
  const result = run(APPVERSION, ["--delete", "--project", PROJECT]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /write flag/);
  assert.equal(result.stdout.includes("project:"), false);
});
