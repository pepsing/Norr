import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { planRelease, referencedIssues, renderNotes } from './release.mjs';
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
  assert.deepEqual(planRelease({ ...initial, releases: [draft] }), { ...metadata, publish: true, tag: draft.tag_name });
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
