import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";
import {join} from "node:path";
import ExcelJS from "exceljs";
import {asBuffer, DRIVE_READONLY_SCOPE, driveMediaUrl} from "../src/roadCharges/driveClient.js";
import {importRoadChargesOnce} from "../src/roadCharges/importOnce.js";
import {parseRoadChargesWorkbook} from "../src/roadCharges/parseWorkbook.js";
import {
  roadChargesDriveFileId,
  roadChargesSyncServiceAccount,
  syncRoadCharges,
  onRoadChargesImportRequest,
  ROAD_CHARGES_SCHEDULE,
} from "../src/roadCharges/syncRoadCharges.js";

const FIXTURE = join(__dirname, "fixtures/FR-UK-Road-Charges-Dataset-v1.1.xlsx");
const FILE_ID = "1FVYnb0Ho6Cr-ITk8rO-gbJdNEVSMzDSK";
const NOW = new Date("2026-11-16T03:20:00.000Z");

/* exceljs 4 types still name the pre-Node-22 Buffer. These bytes are a Node Buffer. */
function loadWorkbook(workbook: ExcelJS.Workbook, bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  return workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
}

describe("road charges workbook", () => {
  it("loads v1.1, keeps FALSE() formulas, and does not invent cc or ulez aliases", async () => {
    const bytes = readFileSync(FIXTURE);
    const workbook = new ExcelJS.Workbook();
    await loadWorkbook(workbook, bytes);
    const sheet = workbook.getWorksheet("road_charges");
    assert.ok(sheet);
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, col) => {
      headers[col] = String(cell.value);
    });
    const is247 = headers.indexOf("is_24_7");
    const appliesEv = headers.indexOf("applies_to_ev");
    const formula = sheet.getRow(2).getCell(is247).value as {formula?: string; result?: unknown};
    assert.equal(formula.formula, "FALSE()");
    assert.equal(formula.result, undefined);
    const ulezFormula = sheet.getRow(3).getCell(appliesEv).value as {formula?: string; result?: unknown};
    assert.equal(ulezFormula.formula, "FALSE()");
    assert.equal(ulezFormula.result, undefined);

    const parsed = await parseRoadChargesWorkbook(bytes);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.dataset.version, "v1.1");
    assert.equal(parsed.dataset.charges.length, 151);
    assert.equal(parsed.dataset.points.length, 34);
    assert.equal(parsed.dataset.rates.length, 280);
    const ids = parsed.dataset.charges.map((charge) => charge.id);
    assert.equal(ids.includes("uk-lon-congestion-charge"), true);
    assert.equal(ids.includes("uk-lon-ulez"), true);
    assert.equal(ids.includes("cc"), false);
    assert.equal(ids.includes("ulez"), false);

    const cc = parsed.dataset.charges.find((charge) => charge.id === "uk-lon-congestion-charge");
    const ulez = parsed.dataset.charges.find((charge) => charge.id === "uk-lon-ulez");
    assert.ok(cc);
    assert.ok(ulez);
    assert.equal(cc.fields.is_24_7, false);
    assert.equal(cc.fields.applies_to_private_car, true);
    assert.equal(cc.fields.car_std_gbp, 18);
    assert.equal(cc.fields.ev_car_gbp, 13.5);
    assert.equal(cc.fields.taxi_phv_gbp, 18);
    assert.equal(cc.fields.charge_type, "congestion_charge");
    assert.equal(cc.fields.geometry_type, "zone");
    assert.equal(cc.fields.last_verified, "2026-11-03");
    assert.equal(cc.fields.effective_from, "2026-01-02");
    assert.equal(cc.fields.effective_to, null);
    assert.deepEqual(cc.fields.location, {latitude: 51.5145, longitude: -0.115});
    assert.equal("ring" in cc.fields, false);
    assert.equal("polygon" in cc.fields, false);
    assert.equal("hours" in cc.fields, false);
    assert.equal("chargePence" in cc.fields, false);
    assert.match(String(cc.fields.charge_hours), /07:00/);
    assert.equal(ulez.fields.is_24_7, true);
    assert.equal(ulez.fields.applies_to_ev, false);
    assert.equal(ulez.fields.car_std_gbp, 12.5);
    assert.equal(ulez.fields.charge_type, "ultra_low_emission_zone");
    assert.equal(parsed.dataset.charges.filter((charge) => charge.fields.status === "ended").length > 0, true);
    assert.equal(parsed.dataset.charges.filter((charge) => charge.fields.data_confidence === "verify_before_release").length, 3);

    const portal = parsed.dataset.points.find((point) => point.id === "blackwall-n-portal");
    assert.equal(portal?.parentId, "uk-lon-blackwall-tunnel");
    assert.equal(portal?.fields.point_type, "tunnel_portal");
    assert.equal(typeof portal?.fields.lat, "number");
    const rate = parsed.dataset.rates.find((item) => item.fields.rate_id === "uk-lon-congestion-charge--car--standard--charging_hours");
    const compliant = parsed.dataset.rates.find((item) => item.fields.rate_id === "uk-lon-ulez--ev_or_compliant--n/a--all_day");
    assert.equal(compliant?.id, "uk-lon-ulez--ev_or_compliant--n_a--all_day");
    assert.equal(rate?.parentId, "uk-lon-congestion-charge");
    assert.equal(rate?.fields.amount_gbp, 18);
    assert.equal(rate?.fields.unit, "per_day");
    assert.equal(rate?.fields.vehicle_class, "car");
  });

  it("rejects an unknown enum and an orphaned point without publishing", async () => {
    const bytes = readFileSync(FIXTURE);
    const badEnum = new ExcelJS.Workbook();
    await loadWorkbook(badEnum, bytes);
    const charges = badEnum.getWorksheet("road_charges");
    assert.ok(charges);
    let chargeTypeCol = 0;
    charges.getRow(1).eachCell((cell, col) => {
      if (cell.value === "charge_type") chargeTypeCol = col;
    });
    charges.getRow(2).getCell(chargeTypeCol).value = "not_a_real_type";
    const enumBytes = Buffer.from(await badEnum.xlsx.writeBuffer());
    const enumParsed = await parseRoadChargesWorkbook(enumBytes);
    assert.equal(enumParsed.ok, false);
    if (!enumParsed.ok) assert.match(enumParsed.reason, /charge_type/);

    const orphan = new ExcelJS.Workbook();
    await loadWorkbook(orphan, bytes);
    const points = orphan.getWorksheet("charge_points");
    assert.ok(points);
    let parentCol = 0;
    points.getRow(1).eachCell((cell, col) => {
      if (cell.value === "parent_doc_id") parentCol = col;
    });
    points.getRow(2).getCell(parentCol).value = "missing-parent";
    const orphanParsed = await parseRoadChargesWorkbook(Buffer.from(await orphan.xlsx.writeBuffer()));
    assert.equal(orphanParsed.ok, false);
    if (!orphanParsed.ok) assert.match(orphanParsed.reason, /parent_doc_id/);
  });

  it("is idempotent and will not wipe the collection when the file shrinks", async () => {
    const bytes = readFileSync(FIXTURE);
    let downloads = 0;
    const first = await importRoadChargesOnce({
      now: NOW,
      enabled: true,
      fileId: FILE_ID,
      lastGoodDocCount: null,
      lastGoodPointCount: null,
      lastGoodRateCount: null,
      existing: [],
      loadFile: async () => {
        downloads += 1;
        return bytes;
      },
    });
    assert.equal(downloads, 1);
    assert.equal(first.status, "ok");
    assert.equal(first.charges, 151);
    assert.equal(first.points, 34);
    assert.equal(first.rates, 280);
    assert.equal(first.plan.sets.length, 151 + 34 + 280);
    assert.equal(first.plan.deletes.length, 0);
    assert.equal(first.plan.unchanged, 0);
    assert.equal(first.datasetVersion, "v1.1");
    assert.equal(first.config?.lastAbortReason, null);
    assert.equal(first.config?.sourceFileId, FILE_ID);
    const cc = first.plan.sets.find((doc) => doc.path === "roadCharges/uk-lon-congestion-charge");
    const ulez = first.plan.sets.find((doc) => doc.path === "roadCharges/uk-lon-ulez");
    assert.ok(cc);
    assert.ok(ulez);
    assert.equal(first.plan.sets.some((doc) => doc.path === "roadCharges/cc"), false);
    assert.equal(first.plan.sets.some((doc) => doc.path === "roadCharges/ulez"), false);
    assert.equal(
      first.plan.sets.some((doc) => doc.path === "roadCharges/uk-lon-blackwall-tunnel/charge_points/blackwall-n-portal"),
      true,
    );
    assert.equal(
      first.plan.sets.some((doc) => doc.path.startsWith("roadCharges/uk-lon-congestion-charge/rates/")),
      true,
    );

    const existing = first.plan.sets.map((doc) => ({
      path: doc.path,
      contentHash: String(doc.data.contentHash),
    }));
    const second = await importRoadChargesOnce({
      now: new Date(NOW.getTime() + 60 * 60 * 1000),
      enabled: true,
      fileId: FILE_ID,
      lastGoodDocCount: 151,
      lastGoodPointCount: 34,
      lastGoodRateCount: 280,
      existing,
      loadFile: async () => bytes,
    });
    assert.equal(second.status, "ok");
    assert.equal(second.plan.sets.length, 0);
    assert.equal(second.plan.deletes.length, 0);
    assert.equal(second.plan.unchanged, 151 + 34 + 280);

    const dropped = await importRoadChargesOnce({
      now: NOW,
      enabled: true,
      fileId: FILE_ID,
      lastGoodDocCount: 151,
      lastGoodPointCount: 34,
      lastGoodRateCount: 280,
      existing,
      loadFile: async () => Buffer.from("not an xlsx"),
    });
    assert.equal(dropped.status, "aborted");
    assert.equal(dropped.plan.deletes.length, 0);
    assert.match(dropped.abortReason ?? "", /^workbook-unreadable|drive-read-error/);

    const shrunk = await importRoadChargesOnce({
      now: NOW,
      enabled: true,
      fileId: FILE_ID,
      lastGoodDocCount: 200,
      lastGoodPointCount: null,
      lastGoodRateCount: null,
      existing,
      loadFile: async () => bytes,
    });
    assert.equal(shrunk.status, "aborted");
    assert.equal(shrunk.abortReason, "charge-count-dropped");
    assert.equal(shrunk.plan.deletes.length, 0);

    let calls = 0;
    const off = await importRoadChargesOnce({
      now: NOW,
      enabled: false,
      fileId: FILE_ID,
      lastGoodDocCount: null,
      lastGoodPointCount: null,
      lastGoodRateCount: null,
      existing: [],
      loadFile: async () => {
        calls += 1;
        return bytes;
      },
    });
    assert.equal(calls, 0);
    assert.equal(off.status, "disabled");
  });

  it("pins the Drive file, the runtime account, and the hourly schedule", () => {
    const account = "road-charges-sync@ferro-maps-staging-v2.iam.gserviceaccount.com";
    assert.equal(DRIVE_READONLY_SCOPE, "https://www.googleapis.com/auth/drive.readonly");
    assert.match(driveMediaUrl(FILE_ID), /alt=media/);
    assert.match(driveMediaUrl(FILE_ID), /supportsAllDrives=true/);
    assert.equal(roadChargesDriveFileId.options.default, FILE_ID);
    assert.equal(roadChargesSyncServiceAccount.options.default, account);
    assert.equal(syncRoadCharges.__endpoint.serviceAccountEmail, roadChargesSyncServiceAccount);
    assert.equal(onRoadChargesImportRequest.__endpoint.serviceAccountEmail, roadChargesSyncServiceAccount);
    assert.equal(syncRoadCharges.__endpoint.scheduleTrigger?.schedule, ROAD_CHARGES_SCHEDULE.schedule);
    assert.equal(syncRoadCharges.__endpoint.scheduleTrigger?.timeZone, "Europe/London");
    assert.equal(String(syncRoadCharges.__endpoint.serviceAccountEmail).includes("compute@developer"), false);
    const body = asBuffer(Uint8Array.from([1, 2, 3]));
    assert.equal(body.length, 3);
  });
});
