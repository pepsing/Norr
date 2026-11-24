import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const watchDirectory = resolve(scriptsDirectory, "../src-tauri/watch");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "norr-watch-tests-"));
const executable = join(temporaryDirectory, "watch-tests");

function run(command, argumentsList) {
  const result = spawnSync(command, argumentsList, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.signal ?? result.status}`);
  }
}

try {
  run("swiftc", [
    "-Onone",
    resolve(watchDirectory, "../ios/Sources/NorrMobile/WatchSyncPolicy.swift"),
    join(watchDirectory, "Network/WatchSnapshot.swift"),
    join(watchDirectory, "Network/WatchXchanger.swift"),
    join(watchDirectory, "Network/WatchWire.swift"),
    join(watchDirectory, "Tests/main.swift"),
    "-o",
    executable,
  ]);
  run(executable, []);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
