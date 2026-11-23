import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const indexesPath = join(repoRoot, "firestore.indexes.json");
const livePath = join(here, "fixtures/vehicle-indexes-live-raw-20261123T080315.json");

// Same defaults firebase-tools 15 uses when firestore.indexes.json omits them
// on a Standard edition database. A missing density matches SPARSE_ALL.
const DEFAULT_API_SCOPE = "ANY_API";
const DEFAULT_DENSITY = "SPARSE_ALL";
const DEFAULT_MULTIKEY = false;

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionalMatch(left, right, fallback) {
  return (left === undefined ? fallback : left) === (right === undefined ? fallback : right);
}

// Firestore appends __name__ in the direction of the last ordered field.
// firebase firestore:indexes prints that suffix. It is automatic when it is
// only the trailing field and its order is that default. A different order is
// explicit and must stay in the file.
export function automaticNameOrder(fields) {
  const explicit = fields.at(-1)?.fieldPath === "__name__" ? fields.slice(0, -1) : fields;
  let order = "ASCENDING";
  for (const field of explicit) {
    if (field.order) order = field.order;
  }
  return order;
}

export function isAutomaticNameField(fields) {
  const last = fields.at(-1);
  if (!last || last.fieldPath !== "__name__" || last.arrayConfig) return false;
  if (fields.slice(0, -1).some((field) => field.fieldPath === "__name__")) return false;
  return last.order === automaticNameOrder(fields);
}

function withAutomaticName(fields) {
  if (fields.at(-1)?.fieldPath === "__name__") return fields;
  return [...fields, {fieldPath: "__name__", order: automaticNameOrder(fields)}];
}

function fieldEqual(liveField, fileField) {
  return liveField.fieldPath === fileField.fieldPath
    && liveField.order === fileField.order
    && liveField.arrayConfig === fileField.arrayConfig;
}

// Mirrors FirestoreApi.indexMatchesSpec for a Standard edition database:
// deploy deletes a live composite only when no file entry matches.
export function indexMatches(liveIndex, fileIndex) {
  if (liveIndex.collectionGroup !== fileIndex.collectionGroup) return false;
  if (liveIndex.queryScope !== fileIndex.queryScope) return false;
  if (!optionalMatch(liveIndex.apiScope, fileIndex.apiScope, DEFAULT_API_SCOPE)) return false;
  if (!optionalMatch(liveIndex.density, fileIndex.density, DEFAULT_DENSITY)) return false;
  if (!optionalMatch(liveIndex.multikey, fileIndex.multikey, DEFAULT_MULTIKEY)) return false;

  const liveFields = liveIndex.fields;
  const fileFields = withAutomaticName(fileIndex.fields);
  if (liveFields.length !== fileFields.length) return false;
  return liveFields.every((field, i) => fieldEqual(field, fileFields[i]));
}

function overrideIdentity(override) {
  return `${override.collectionGroup}.${override.fieldPath}`;
}

function overrideSpec(override) {
  return {
    ttl: override.ttl ?? false,
    indexes: (override.indexes ?? []).map((index) => ({
      order: index.order,
      arrayConfig: index.arrayConfig,
      queryScope: index.queryScope,
    })),
  };
}

export function findRemovals(fileSpec, liveSpec) {
  const indexRemovals = liveSpec.indexes.filter(
    (liveIndex) => !fileSpec.indexes.some((fileIndex) => indexMatches(liveIndex, fileIndex)),
  );
  const fieldOverrideRemovals = liveSpec.fieldOverrides.filter(
    (liveOverride) => !fileSpec.fieldOverrides.some(
      (fileOverride) => overrideIdentity(fileOverride) === overrideIdentity(liveOverride),
    ),
  );
  const fieldOverrideSpecMismatches = liveSpec.fieldOverrides.flatMap((liveOverride) => {
    const fileOverride = fileSpec.fieldOverrides.find(
      (candidate) => overrideIdentity(candidate) === overrideIdentity(liveOverride),
    );
    if (!fileOverride) return [];
    if (JSON.stringify(overrideSpec(fileOverride)) !== JSON.stringify(overrideSpec(liveOverride))) {
      return [overrideIdentity(liveOverride)];
    }
    return [];
  });
  return {indexRemovals, fieldOverrideRemovals, fieldOverrideSpecMismatches};
}

function describeIndex(index) {
  const fields = index.fields
    .filter((field) => !(field.fieldPath === "__name__" && isAutomaticNameField(index.fields)))
    .map((field) => `${field.fieldPath} ${field.order ?? field.arrayConfig}`)
    .join(", ");
  return `${index.collectionGroup} [${fields}]`;
}

export function reportRemovals(fileSpec, liveSpec) {
  const found = findRemovals(fileSpec, liveSpec);
  const removals = found.indexRemovals.length + found.fieldOverrideRemovals.length;
  const lines = [
    `index removals: ${found.indexRemovals.length}`,
    ...found.indexRemovals.map((index) => `  - ${describeIndex(index)}`),
    `field override removals: ${found.fieldOverrideRemovals.length}`,
    ...found.fieldOverrideRemovals.map((override) => `  - ${overrideIdentity(override)}`),
    `field override spec mismatches: ${found.fieldOverrideSpecMismatches.length}`,
    ...found.fieldOverrideSpecMismatches.map((name) => `  - ${name}`),
    `removals: ${removals}`,
  ];
  return {removals, ...found, text: lines.join("\n")};
}

test("firestore.indexes.json is a strict superset of the live ferro-maps-staging-v2 snapshot", () => {
  const report = reportRemovals(load(indexesPath), load(livePath));
  console.log(report.text);
  assert.equal(report.removals, 0);
  assert.deepEqual(report.fieldOverrideSpecMismatches, []);
  assert.equal(report.indexRemovals.length, 0);
  assert.equal(report.fieldOverrideRemovals.length, 0);
});

test("a non-automatic __name__ order is not treated as covered by the implicit suffix", () => {
  const liveIndex = {
    collectionGroup: "audit",
    queryScope: "COLLECTION",
    density: "SPARSE_ALL",
    fields: [
      {fieldPath: "createdAt", order: "DESCENDING"},
      {fieldPath: "__name__", order: "ASCENDING"},
    ],
  };
  const fileIndex = {
    collectionGroup: "audit",
    queryScope: "COLLECTION",
    fields: [{fieldPath: "createdAt", order: "DESCENDING"}],
  };
  assert.equal(isAutomaticNameField(liveIndex.fields), false);
  assert.equal(indexMatches(liveIndex, fileIndex), false);
  const kept = {
    ...fileIndex,
    fields: [
      {fieldPath: "createdAt", order: "DESCENDING"},
      {fieldPath: "__name__", order: "ASCENDING"},
    ],
  };
  assert.equal(indexMatches(liveIndex, kept), true);
});
