import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateVersion(version, buildNumber) {
  if (!/^\d+\.\d+\.\d+-alpha\.[1-9]\d*$/.test(version)) {
    throw new Error('Expected an alpha version such as 0.1.0-alpha.1');
  }
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1001 || buildNumber > 2_100_000_000) {
    throw new Error('Invalid native build number');
  }
}

export function applyVersion(version, buildNumber) {
  validateVersion(version, buildNumber);
  const updateJson = (path, update) => {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    update(value);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  };
  for (const path of ['package.json', 'apps/web/package.json', 'apps/native/package.json']) {
    updateJson(path, (value) => { value.version = version; });
  }
  updateJson('package-lock.json', (value) => {
    value.version = version;
    for (const path of ['', 'apps/web', 'apps/native']) value.packages[path].version = version;
  });
  const cargo = readFileSync('Cargo.toml', 'utf8');
  writeFileSync('Cargo.toml', cargo.replace(/^(version = ")[^"]+(")$/m, (_, start, end) => `${start}${version}${end}`));
  const lock = readFileSync('Cargo.lock', 'utf8');
  writeFileSync('Cargo.lock', lock.replace(
    /(name = "(?:norr|norr-vehicle-core)"\nversion = ")[^"]+(")/g,
    (_, start, end) => `${start}${version}${end}`,
  ));
  updateJson('apps/native/src-tauri/tauri.conf.json', (value) => {
    value.version = version;
    value.bundle.macOS.bundleVersion = String(buildNumber);
    value.bundle.iOS = { ...value.bundle.iOS, bundleVersion: String(buildNumber) };
    value.bundle.android = { ...value.bundle.android, versionCode: buildNumber };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyVersion(process.argv[2], Number(process.argv[3]));
}
