import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('release version updates every workspace crate in Cargo.lock', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), 'norr-release-version-'));
  try {
    for (const path of [
      'package.json', 'package-lock.json', 'apps/web/package.json',
      'apps/native/package.json', 'Cargo.toml', 'Cargo.lock',
      'apps/native/src-tauri/tauri.conf.json',
    ]) {
      const target = join(fixture, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, path), target);
    }
    execFileSync(process.execPath, [join(root, 'scripts/release/version.mjs'), '0.2.0', '1020'], { cwd: fixture });
    const workspace = readFileSync(join(root, 'Cargo.toml'), 'utf8');
    const members = workspace.match(/members\s*=\s*\[([^\]]+)\]/s)[1].matchAll(/"([^"]+)"/g);
    const packages = readFileSync(join(fixture, 'Cargo.lock'), 'utf8').split('[[package]]');
    for (const [, member] of members) {
      const manifest = readFileSync(join(root, member, 'Cargo.toml'), 'utf8');
      if (!/^version\.workspace\s*=\s*true/m.test(manifest)) continue;
      const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)[1];
      const entry = packages.find((value) => value.includes(`name = "${name}"\n`));
      assert.ok(entry?.includes('version = "0.2.0"\n'), `${name} must match the release version`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
