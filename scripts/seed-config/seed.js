#!/usr/bin/env node
/**
 * Seed config/flags and config/categories.
 *
 * Dry-run is the default and does not connect to Firestore.
 * --project is required. --write is refused unless FIRESTORE_EMULATOR_HOST
 * is set and the project id starts with demo-.
 *
 *   node scripts/seed-config/seed.js --project demo-ferromaps-rules
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *     node scripts/seed-config/seed.js --project demo-ferromaps-rules --write
 */
const {flagsDocument, containsMinVersion, assertPinsV1Off} = require("./flags");
const {categoriesDocument} = require("./categories");

function parseArgs(argv) {
  const args = {write: false, project: ""};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--write") args.write = true;
    else if (token === "--project") args.project = argv[i + 1] || "";
    else if (token.startsWith("--project=")) args.project = token.slice("--project=".length);
  }
  return args;
}

function documents() {
  const flags = flagsDocument();
  const categories = categoriesDocument();
  assertPinsV1Off(flags);
  if (containsMinVersion(flags) || containsMinVersion(categories)) {
    throw new Error("seed documents must not contain minVersion");
  }
  return {flags, categories};
}

function assertWritable(project) {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("Refusing to write: FIRESTORE_EMULATOR_HOST is not set. This script does not touch a real project.");
  }
  if (!project.startsWith("demo-")) {
    throw new Error(`Refusing to write: project ${project} must start with demo-.`);
  }
}

async function writeDocuments(project, docs) {
  assertWritable(project);
  const {initializeApp, getApps} = require("firebase-admin/app");
  const {getFirestore} = require("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({projectId: project});
  const db = getFirestore();
  await db.doc("config/flags").set(docs.flags);
  await db.doc("config/categories").set(docs.categories);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.project) {
    console.error("Refusing to run without --project.");
    process.exitCode = 1;
    return;
  }
  const docs = documents();
  if (!args.write) {
    console.log(JSON.stringify({dryRun: true, project: args.project, ...docs}, null, 2));
    console.log("pinsV1 is false. Leave it off until the static pin seed has run and no g5 tile is over 500.");
    return;
  }
  await writeDocuments(args.project, docs);
  console.log(`Wrote config/flags and config/categories to emulator project ${args.project}.`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = {parseArgs, documents, assertWritable, main};
