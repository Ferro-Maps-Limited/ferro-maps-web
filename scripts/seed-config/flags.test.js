const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveFlag,
  flagsDocument,
  containsMinVersion,
  assertPinsV1Off,
} = require("./flags");
const {categoriesDocument, categoryVisible, DISPLAY} = require("./categories");
const {parseArgs, documents, assertWritable} = require("./seed");

test("missing flags: surge and parking on, pinsV1 off", () => {
  for (const platform of ["android", "ios"]) {
    assert.equal(resolveFlag(null, "surge", platform, "1.0.0"), true);
    assert.equal(resolveFlag(undefined, "parking", platform, "1.0.0"), true);
    assert.equal(resolveFlag({}, "pinsV1", platform, "1.0.0"), false);
    assert.equal(resolveFlag({traffic: "yes"}, "traffic", platform, "1.0.0"), false);
  }
});

test("ios false forces off and android true forces on", () => {
  const doc = {
    Surge: {enabled: true, ios: false},
    parking: {enabled: false, android: true, ios: {enabled: false}},
  };
  assert.equal(resolveFlag(doc, "surge", "ios", "2.0.0"), false);
  assert.equal(resolveFlag(doc, "surge", "android", "2.0.0"), true);
  assert.equal(resolveFlag(doc, "parking", "android", "2.0.0"), true);
  assert.equal(resolveFlag(doc, "parking", "ios", "2.0.0"), false);
});

test("the seed has every default and no minVersion", () => {
  const flags = flagsDocument();
  assert.equal(flags.surge, true);
  assert.equal(flags.parking, true);
  assert.equal(flags.pinsV1, false);
  assert.equal(flags.payOrIgnore, false);
  assert.equal(flags.surgeReports, false);
  assert.equal(containsMinVersion(flags), false);
  assert.equal(containsMinVersion(categoriesDocument()), false);
  assert.equal(documents().flags.pinsV1, false);
});

test("pinsV1 true is refused", () => {
  assert.throws(() => assertPinsV1Off({pinsV1: true}), /pinsV1 must stay off/);
  assert.throws(() => assertPinsV1Off({pinsV1: {enabled: false, ios: true}}), /pinsV1 must stay off/);
});

test("categories outside the 14 keys are not filtered, and a false key is", () => {
  const doc = categoriesDocument();
  assert.equal(doc.categories.length, 14);
  assert.deepEqual(doc.categories.map((row) => row.label), DISPLAY.map((row) => row[1]));
  assert.equal(categoryVisible(doc, "contribute", "1"), true);
  assert.equal(categoryVisible(null, "parking", "1"), true);
  assert.equal(categoryVisible({
    categories: [
      {key: "pub", enabled: false},
      {key: "Pub", enabled: true},
    ],
  }, "pub", "1"), false);
});

test("the CLI defaults to dry-run and requires a project", () => {
  assert.deepEqual(parseArgs([]), {write: false, project: ""});
  assert.equal(parseArgs(["--project", "demo-ferromaps-rules"]).write, false);
  assert.equal(parseArgs(["--project", "demo-x", "--write"]).write, true);
  const prev = process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  assert.throws(() => assertWritable("demo-ferromaps-rules"), /FIRESTORE_EMULATOR_HOST/);
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  assert.throws(() => assertWritable("ferro-maps-staging-v2"), /demo-/);
  assert.doesNotThrow(() => assertWritable("demo-ferromaps-rules"));
  if (prev === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
  else process.env.FIRESTORE_EMULATOR_HOST = prev;
});
