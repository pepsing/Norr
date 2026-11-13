import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { planRelease, prepareAssets, referencedIssues, renderNotes } from './release.mjs';
import { validateVersion } from './version.mjs';

const initial = { sha: 'a'.repeat(40), baseVersion: '0.1.0', releases: [], tags: [] };

test('first alpha starts above the installed Android build number', () => {
  const plan = planRelease(initial);
  assert.equal(plan.tag, 'v0.1.0-alpha.1');
  assert.equal(plan.buildNumber, 1001);
  assert.equal(plan.publish, true);
});

test('unchanged source skips builds and releases', () => {
  const plan = planRelease({ ...initial, releases: [{ draft: false, sha: initial.sha, tag_name: 'v0.1.0-alpha.1' }] });
  assert.equal(plan.publish, false);
});

test('new commits increment versions and retain the previous release boundary', () => {
  const release = {
    draft: false, sha: 'b'.repeat(40), tag_name: 'v0.1.0-alpha.9',
    body: '<!-- norr-release {"buildNumber":1009} -->',
  };
  const plan = planRelease({ ...initial, releases: [release], tags: ['v0.1.0-alpha.10', 'v0.1.0-alpha.invalid'] });
  assert.equal(plan.version, '0.1.0-alpha.11');
  assert.equal(plan.buildNumber, 1010);
  assert.equal(plan.previousTag, release.tag_name);
});

test('a partial draft upload resumes its version, source and native build number', () => {
  const metadata = { sha: initial.sha, version: '0.1.0-alpha.2', buildNumber: 1002, previousTag: 'v0.1.0-alpha.1' };
  const draft = { draft: true, tag_name: 'v0.1.0-alpha.2', body: `<!-- norr-release ${JSON.stringify(metadata)} -->` };
  assert.deepEqual(planRelease({ ...initial, releases: [draft] }), { ...metadata, platform: 'all', publish: true, tag: draft.tag_name });
});

test('Windows-only publication leaves other platforms eligible for the next full release', () => {
  const full = { draft: false, sha: 'b'.repeat(40), tag_name: 'v0.1.0-alpha.1', published_at: '2026-11-12T00:00:00Z',
    body: '<!-- norr-release {"buildNumber":1001} -->' };
  const windows = { draft: false, sha: initial.sha, tag_name: 'v0.1.0-alpha.2', published_at: '2026-11-13T00:00:00Z',
    body: '<!-- norr-release {"buildNumber":1002,"platform":"windows"} -->' };
  const input = { ...initial, releases: [full, windows] };
  assert.equal(planRelease({ ...input, platform: 'windows' }).publish, false);
  const plan = planRelease(input);
  assert.equal(plan.publish, true);
  assert.equal(plan.platform, 'all');
  assert.equal(plan.previousTag, full.tag_name);
  assert.equal(plan.version, '0.1.0-alpha.3');
});

test('draft retries retain their selected platform and reject invalid platform names', () => {
  const metadata = { sha: initial.sha, version: '0.1.0-alpha.2', buildNumber: 1002, previousTag: '', platform: 'windows' };
  const draft = { draft: true, tag_name: 'v0.1.0-alpha.2', body: `<!-- norr-release ${JSON.stringify(metadata)} -->` };
  assert.equal(planRelease({ ...initial, releases: [draft], platform: 'windows' }).tag, draft.tag_name);
  assert.equal(planRelease({ ...initial, releases: [draft], platform: 'all' }).tag, 'v0.1.0-alpha.3');
  assert.throws(() => planRelease({ ...initial, platform: 'invalid' }), /Invalid release platform/);
});

test('Windows-only assets and release notes include exactly the selected package', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-windows-release-'));
  try {
    mkdirSync(join(directory, 'Norr-windows-x64'));
    writeFileSync(join(directory, 'Norr-windows-x64', 'Norr-setup.exe'), 'windows-package');
    const files = prepareAssets('0.1.0-alpha.6', directory, 'windows');
    assert.deepEqual(files.map(file => file.name), ['Norr_0.1.0-alpha.6_windows-x64-setup.exe', 'SHA256SUMS.txt']);
    assert.equal(readFileSync(files[1].path, 'utf8').trim().split('\n').length, 1);
    const plan = { ...planRelease({ ...initial, platform: 'windows' }), previousTag: 'v0.1.0-alpha.5' };
    const notes = renderNotes(plan, [], [], 'pepsing/Norr', 'https://github.com/pepsing/Norr/actions/runs/1');
    assert.match(notes, /windows-x64-setup.exe/);
    assert.doesNotMatch(notes, /macos-arm64.zip|ios-arm64|android-arm64|四端构建/);
    assert.match(notes, /"platform":"windows"/);
    rmSync(join(directory, 'Norr-windows-x64', 'Norr-setup.exe'));
    assert.throws(() => prepareAssets('0.1.0-alpha.6', directory, 'windows'), /exactly one package/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('base version changes keep native build numbers increasing', () => {
  const release = { draft: false, sha: 'b'.repeat(40), tag_name: 'v0.1.0-alpha.20', body: '<!-- norr-release {"buildNumber":1020} -->' };
  const plan = planRelease({ ...initial, baseVersion: '0.2.0', releases: [release] });
  assert.equal(plan.version, '0.2.0-alpha.1');
  assert.equal(plan.buildNumber, 1021);
});

test('issue references are deduplicated and limited to the current repository', () => {
  assert.deepEqual(referencedIssues('Fixes #12, relates to #12\nhttps://github.com/pepsing/Norr/issues/34\nother/repo#88 https://github.com/other/repo/issues/99', 'pepsing/Norr'), [12, 34]);
});

test('notes include actual changes and issue links without claiming open issues are fixed', () => {
  const plan = { ...planRelease(initial), previousTag: 'v0.1.0-alpha.1' };
  const notes = renderNotes(plan,
    [{ title: 'fix: refresh climate state [skip ci]', label: 'PR #8', url: 'https://github.com/pepsing/Norr/pull/8' }],
    [{ number: 7, title: '空调状态未刷新', state: 'open', html_url: 'https://github.com/pepsing/Norr/issues/7' }],
    'pepsing/Norr', 'https://github.com/pepsing/Norr/actions/runs/1');
  assert.match(notes, /refresh climate state/);
  assert.match(notes, /空调状态未刷新（待确认）/);
  assert.match(notes, /issues\/7/);
  assert.match(notes, /compare\//);
  assert.doesNotMatch(notes, /首个 alpha/);
  assert.doesNotMatch(notes, /skip ci/);
  assert.match(notes, /macos-arm64.zip/);
  assert.match(notes, /macos-x64.zip.*Intel Mac/);
  assert.match(notes, /ios-arm64-unsigned.ipa.*重新签名/);
});

test('release requires both Mac architectures and both iOS packages, with checksums', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-assets-'));
  try {
    const packages = [
      ['Norr-macos-arm64', 'macos-arm64.zip'],
      ['Norr-macos-x64', 'macos-x64.zip'],
      ['Norr-windows-x64', 'windows-x64-setup.exe'],
      ['Norr-android-arm64', 'android-arm64.apk'],
      ['Norr-ios-arm64-simulator', 'ios-arm64-simulator.zip'],
      ['Norr-ios-arm64-unsigned', 'ios-arm64-unsigned.ipa'],
    ];
    for (const [artifact, suffix] of packages) {
      mkdirSync(join(directory, artifact));
      writeFileSync(join(directory, artifact, suffix), artifact);
    }
    const files = prepareAssets('0.1.0-alpha.2', directory);
    assert.deepEqual(files.map((file) => file.name), [
      ...packages.map(([, suffix]) => `Norr_0.1.0-alpha.2_${suffix}`), 'SHA256SUMS.txt',
    ]);
    const checksums = readFileSync(files.at(-1).path, 'utf8');
    for (const [index, [artifact]] of packages.entries()) {
      const digest = createHash('sha256').update(artifact).digest('hex');
      assert.equal(files[index].digest, `sha256:${digest}`);
      assert.ok(checksums.includes(`${digest}  ${files[index].name}\n`));
    }
    rmSync(join(directory, 'Norr-ios-arm64-unsigned', 'ios-arm64-unsigned.ipa'));
    assert.throws(() => prepareAssets('0.1.0-alpha.2', directory), /exactly one package in Norr-ios-arm64-unsigned/);
    writeFileSync(join(directory, 'Norr-ios-arm64-unsigned', 'ios-arm64-unsigned.ipa'), 'Norr-ios-arm64-unsigned');
    rmSync(join(directory, 'Norr-macos-x64'), { recursive: true });
    assert.throws(() => prepareAssets('0.1.0-alpha.2', directory), /Norr-macos-x64/);
    mkdirSync(join(directory, 'Norr-macos-x64'));
    assert.throws(() => prepareAssets('0.1.0-alpha.2', directory), /exactly one package/);
    for (const name of ['first.zip', 'second.zip']) writeFileSync(join(directory, 'Norr-macos-x64', name), name);
    assert.throws(() => prepareAssets('0.1.0-alpha.2', directory), /exactly one package/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid versions and native build numbers fail before writing files', () => {
  assert.throws(() => validateVersion('0.1.0', 1001));
  assert.throws(() => validateVersion('0.1.0-alpha.0', 1001));
  assert.throws(() => validateVersion('0.1.0-alpha.1', 1000));
  assert.throws(() => validateVersion('0.1.0-alpha.1', 2_100_000_001));
});

test('version injection updates locked workspace packages and platform build numbers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-version-'));
  try {
    const paths = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock',
      'apps/web/package.json', 'apps/native/package.json', 'apps/native/src-tauri/tauri.conf.json'];
    for (const path of paths) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      copyFileSync(path, join(directory, path));
    }
    execFileSync(process.execPath, [resolve('scripts/release/version.mjs'), '0.1.0-alpha.3', '1003'], { cwd: directory });
    const config = JSON.parse(readFileSync(join(directory, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(config.version, '0.1.0-alpha.3');
    assert.equal(config.bundle.android.versionCode, 1003);
    assert.equal(config.bundle.macOS.bundleVersion, '1003');
    assert.equal(config.bundle.iOS.bundleVersion, '1003');
    assert.match(readFileSync(join(directory, 'Cargo.toml'), 'utf8'), /version = "0.1.0-alpha.3"/);
    assert.match(readFileSync(join(directory, 'Cargo.lock'), 'utf8'), /name = "norr"\nversion = "0.1.0-alpha.3"/);
    assert.match(readFileSync(join(directory, 'Cargo.lock'), 'utf8'), /name = "norr-vehicle-core"\nversion = "0.1.0-alpha.3"/);
    const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    for (const path of ['', 'apps/web', 'apps/native']) assert.equal(lock.packages[path].version, config.version);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test('single Windows artifact can be downloaded directly into the artifact root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-single-artifact-'));
  try {
    writeFileSync(join(directory, 'norr-setup.exe'), 'windows installer');
    const files = prepareAssets('0.1.0-alpha.6', directory, 'windows');
    assert.equal(files.length, 2);
    assert.equal(readFileSync(files[0].path, 'utf8'), 'windows installer');
    assert.throws(() => prepareAssets('0.1.0-alpha.6', directory, 'all'), /Norr-macos-arm64/);
    writeFileSync(join(directory, 'duplicate-setup.exe'), 'duplicate');
    assert.throws(() => prepareAssets('0.1.0-alpha.6', directory, 'windows'), /exactly one package/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
