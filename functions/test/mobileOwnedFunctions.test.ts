import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {describe, it} from "node:test";
import {MOBILE_OWNED_FUNCTION_NAMES} from "../src/codebases/mobileOwnedFunctions.js";

// Guard: the web `default` codebase must not export a function name owned by
// the iOS `mobile` codebase. Same name + same region on the same project means
// a web deploy replaces the mobile function. Checks the compiled lib/index.js,
// which is what `firebase deploy` loads.
const builtIndex = join(__dirname, "..", "lib", "index.js");

describe("mobile-owned function names", () => {
  it("lists the names owned by the iOS mobile codebase", () => {
    assert.ok(MOBILE_OWNED_FUNCTION_NAMES.includes("onSubscriptionRequest"));
    assert.ok(MOBILE_OWNED_FUNCTION_NAMES.includes("refreshEntitlements"));
  });

  it("the built web index exports none of them", async () => {
    assert.ok(existsSync(builtIndex), "lib/index.js is missing. Run npm run build first.");
    const mod = (await import(builtIndex)) as {default?: Record<string, unknown>};
    const exported = [...new Set([...Object.keys(mod), ...Object.keys(mod.default ?? {})])];
    assert.ok(exported.length > 0, "lib/index.js exported nothing");
    const clashes = MOBILE_OWNED_FUNCTION_NAMES.filter((name) => exported.includes(name));
    assert.deepEqual(clashes, [], `web index exports mobile-owned functions: ${clashes.join(", ")}`);
  });
});
