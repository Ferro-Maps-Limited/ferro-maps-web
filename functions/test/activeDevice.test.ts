import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {activeDeviceAllowed} from "../src/surge/onHotspotUnlockRequest";

const END_OF_31_DEC_UK = Date.parse("2027-01-01T00:00:00.000Z");

describe("active device check", () => {
  it("matches a presented device id and refuses a different one", () => {
    const user = {activeDeviceId: "phone-a"};
    assert.equal(activeDeviceAllowed(user, "phone-a", END_OF_31_DEC_UK, null), true);
    assert.equal(activeDeviceAllowed(user, "phone-b", END_OF_31_DEC_UK - 1, END_OF_31_DEC_UK), false);
  });

  it("covers the whole UK day of 31 Dec 2026 and stops at the next midnight", () => {
    const user = {activeDeviceId: "phone-a"};
    assert.equal(activeDeviceAllowed(user, null, Date.parse("2026-12-31T00:00:00.000Z"), END_OF_31_DEC_UK), true);
    assert.equal(activeDeviceAllowed(user, null, Date.parse("2026-12-31T23:30:00.000Z"), END_OF_31_DEC_UK), true);
    assert.equal(activeDeviceAllowed(user, null, END_OF_31_DEC_UK, END_OF_31_DEC_UK), false);
  });

  it("allows no stamp only when a grace instant is configured", () => {
    const user = {activeDeviceId: "phone-a"};
    const during = Date.parse("2026-11-13T12:00:00.000Z");
    assert.equal(activeDeviceAllowed(user, null, during, null), false);
    assert.equal(activeDeviceAllowed(user, null, during, during + 1), true);
    assert.equal(activeDeviceAllowed({activeDeviceId: null}, null, during, null), true);
  });
});
