import assert from "node:assert/strict";
import test from "node:test";
import { iosBuildConfig } from "./ios-build-config.mjs";

test("iOS reads the public partner ID independently from login configuration", () => {
  const text = "NORR_POLESTAR_CN_SIGNING_KEY=fixture\nNORR_P4_PARTNER_CLIENT_ID=local-public-id\nOTHER_CONFIG=unused";
  assert.deepEqual(iosBuildConfig({ NORR_P4_PARTNER_CLIENT_ID: "ci-public-id" }, text), {
    NORR_POLESTAR_CN_SIGNING_KEY: "fixture", NORR_P4_PARTNER_CLIENT_ID: "ci-public-id",
  });
  assert.deepEqual(iosBuildConfig({ NORR_POLESTAR_CN_SIGNING_KEY: "fixture" }, ""), {NORR_POLESTAR_CN_SIGNING_KEY: "fixture"});
  assert.equal(iosBuildConfig({}, text).NORR_P4_PARTNER_CLIENT_ID, "local-public-id");
  assert.throws(() => iosBuildConfig({}, ""), /缺少/);
});
