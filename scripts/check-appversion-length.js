#!/usr/bin/env node
/**
 * WEB-BE-15. Read-only count of appVersion values longer than 32 characters.
 * Prints counts, and up to 10 document ids with the length. Never prints the
 * value itself or any other field.
 *
 *   GOOGLE_CLOUD_PROJECT=ferro-maps-staging-v2 \
 *     node scripts/check-appversion-length.js --project ferro-maps-staging-v2
 */
const path = require("path");
const {createRequire} = require("module");
const {parseReadOnlyProject} = require("./read-only-args");

const COLLECTIONS = [
  "users",
  "deviceSessionRequests",
  "subscriptionRequests",
  "accountDeletionRequests",
  "contributionRequests",
  "parkingPaymentRequests",
];

const requireFromFunctions = createRequire(path.join(__dirname, "../functions/package.json"));

async function scan(db, name) {
  const {FieldPath} = requireFromFunctions("firebase-admin/firestore");
  let count = 0;
  const sample = [];
  let last = null;
  for (;;) {
    let query = db.collection(name).orderBy(FieldPath.documentId()).select("appVersion").limit(400);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const value = doc.get("appVersion");
      if (typeof value === "string" && value.length > 32) {
        count += 1;
        if (sample.length < 10) sample.push({id: doc.id, length: value.length});
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  return {count, sample};
}

async function main(argv) {
  const parsed = parseReadOnlyProject(argv);
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const project = parsed.project;
  console.log(`project: ${project}`);

  const {initializeApp, getApps} = requireFromFunctions("firebase-admin/app");
  const {getFirestore} = requireFromFunctions("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({projectId: project});
  const db = getFirestore();

  for (const name of COLLECTIONS) {
    const result = await scan(db, name);
    console.log(`${name}: ${result.count}`);
    for (const row of result.sample) {
      console.log(`  ${row.id} length=${row.length}`);
    }
  }
  console.log("No documents were written.");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {main, COLLECTIONS};
