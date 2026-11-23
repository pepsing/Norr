import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import { nativeBuildConfig, serializeBuildConfig } from "./build-config.mjs";
import { iosBuildConfig } from "./ios-build-config.mjs";

const local = "NORR_POLESTAR_CN_SIGNING_KEY=fixture-login\nNORR_XCHANGER_APP_SECRET=fixture-xchanger\nUNRELATED_SECRET=unused\n";

test("native and Xcode builds resolve each key independently with environment precedence", () => {
  for (const resolve of [nativeBuildConfig, iosBuildConfig]) {
    assert.deepEqual(resolve({ NORR_POLESTAR_CN_SIGNING_KEY: " ci-login " }, local), {
      NORR_POLESTAR_CN_SIGNING_KEY: "ci-login",
      NORR_XCHANGER_APP_SECRET: "fixture-xchanger",
    });
    assert.deepEqual(resolve({ NORR_XCHANGER_APP_SECRET: "ci-xchanger" }, local), {
      NORR_POLESTAR_CN_SIGNING_KEY: "fixture-login",
      NORR_XCHANGER_APP_SECRET: "ci-xchanger",
    });
    assert.equal(resolve({ NORR_XCHANGER_APP_SECRET: " " }, local).NORR_XCHANGER_APP_SECRET, "fixture-xchanger");
  }
});

test("P4 packaging rejects a missing key while login-only builds remain compatible", () => {
  const loginOnly = { NORR_POLESTAR_CN_SIGNING_KEY: "fixture-login" };
  assert.deepEqual(nativeBuildConfig(loginOnly), loginOnly);
  assert.throws(() => nativeBuildConfig(loginOnly, "", { requireXchanger: true }), /缺少 NORR_XCHANGER_APP_SECRET/);
  assert.throws(() => nativeBuildConfig({ NORR_XCHANGER_APP_SECRET: "fixture-secret" }), error => {
    assert.match(error.message, /缺少 NORR_POLESTAR_CN_SIGNING_KEY/);
    assert.ok(!error.message.includes("fixture-secret"));
    return true;
  });
});

test("CI configuration round-trips only approved values for the Xcode subprocess", () => {
  const config = nativeBuildConfig({ NORR_P4_PARTNER_CLIENT_ID: "fixture-client" }, local);
  assert.deepEqual(parseEnv(serializeBuildConfig({ ...config, UNRELATED_SECRET: "unused" })), config);
  assert.deepEqual(iosBuildConfig({}, serializeBuildConfig(config)), config);
  const punctuation = { NORR_POLESTAR_CN_SIGNING_KEY: "fixture# $() ` = ' /+" };
  assert.deepEqual(parseEnv(serializeBuildConfig(punctuation)), punctuation);
});

test("CI writer creates a private file without logging values or overwriting local secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "norr-build-config-"));
  try {
    const scripts = join(root, "apps/native/scripts");
    cpSync(new URL("./", import.meta.url), scripts, { recursive: true });
    const config = nativeBuildConfig({}, local);
    const run = () => spawnSync(process.execPath, [join(scripts, "write-build-config.mjs")], {
      env: { ...process.env, ...config, NORR_P4_PARTNER_CLIENT_ID: "" },
      encoding: "utf8",
    });
    const result = run();
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, "");
    const file = join(root, ".env.secrets");
    assert.deepEqual(parseEnv(readFileSync(file, "utf8")), config);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const cli = join(root, "node_modules/@tauri-apps/cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "tauri.js"), `
      const valid = process.env.NORR_POLESTAR_CN_SIGNING_KEY === 'fixture-login'
        && process.env.NORR_XCHANGER_APP_SECRET === 'fixture-xchanger'
        && process.argv.slice(2).join(' ') === 'ios xcode-script --platform fixture';
      process.exit(valid ? 0 : 1);
    `);
    const xcodeEnvironment = { ...process.env };
    for (const key of Object.keys(xcodeEnvironment)) if (key.startsWith("NORR_")) delete xcodeEnvironment[key];
    const xcode = spawnSync(process.execPath, [join(scripts, "ios-xcode.mjs"), "--platform", "fixture"], {
      env: xcodeEnvironment,
      encoding: "utf8",
    });
    assert.equal(xcode.status, 0);
    assert.equal(xcode.stdout + xcode.stderr, "");
    writeFileSync(file, "existing-local-configuration");
    const existing = run();
    assert.equal(existing.status, 1);
    assert.equal(readFileSync(file, "utf8"), "existing-local-configuration");
    for (const value of Object.values(config)) assert.ok(!(existing.stdout + existing.stderr).includes(value));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows P4 packaging selects the control adapter and diagnostic UI with isolated app config", () => {
  const root = mkdtempSync(join(tmpdir(), "norr-windows-p4-build-"));
  try {
    const scripts = join(root, "apps/native/scripts");
    cpSync(new URL("./", import.meta.url), scripts, { recursive: true });
    writeFileSync(join(root, ".env.secrets"), local, { mode: 0o600 });
    const cli = join(root, "node_modules/@tauri-apps/cli");
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, "tauri.js"), `
      console.log(JSON.stringify({ args: process.argv.slice(2), mode: process.env.VITE_P4_FIELD_TEST,
        configured: process.env.NORR_POLESTAR_CN_SIGNING_KEY === 'fixture-login'
          && process.env.NORR_XCHANGER_APP_SECRET === 'fixture-xchanger' }));
    `);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("NORR_") || key.startsWith("APPLE_")) delete env[key];
    const run = (...args) => spawnSync(process.execPath, [join(scripts, "build.mjs"), "windows", ...args], { env, encoding: "utf8" });
    const result = run("--polestar4-test");
    assert.equal(result.status, 0, result.stderr);
    const build = JSON.parse(result.stdout);
    assert.deepEqual(build.args, ["build", "--bundles", "nsis", "--target", "x86_64-pc-windows-msvc",
      ...(process.platform === "win32" ? [] : ["--runner", "cargo-xwin"]),
      "--features", "polestar4-test", "--config", "src-tauri/tauri.p4-windows-test.conf.json"]);
    assert.equal(build.mode, "windows");
    assert.equal(build.configured, true);
    assert.equal(JSON.parse(run().stdout).mode, "false");
    assert.equal(JSON.parse(run().stdout).configured, true);
    assert.equal(JSON.parse(run("--p4-field-test").stdout).mode, "true");
    assert.equal(run("--polestar4-test", "--p4-field-test").status, 1);
    writeFileSync(join(root, ".env.secrets"), "NORR_POLESTAR_CN_SIGNING_KEY=fixture-login\n");
    const standardMissing = run();
    assert.equal(standardMissing.status, 1);
    assert.match(standardMissing.stderr, /缺少 NORR_XCHANGER_APP_SECRET/);
    assert.equal(run("--p4-field-test").status, 0);
    const missing = run("--polestar4-test");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /缺少 NORR_XCHANGER_APP_SECRET/);
    assert.ok(!(missing.stdout + missing.stderr).includes("fixture-login"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
