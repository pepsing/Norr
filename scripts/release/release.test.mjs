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

test('scheduled releases skip marked commits before requesting release data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-skip-release-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    execFileSync('git', ['-c', 'user.name=Norr test', '-c', 'user.email=test@example.com',
      'commit', '--quiet', '--allow-empty', '-m', 'feat: save work [skip ci] [skip release]'], { cwd: directory });
    const output = join(directory, 'output');
    const summary = join(directory, 'summary');
    execFileSync(process.execPath, [resolve('scripts/release/release.mjs'), 'plan'], {
      cwd: directory,
      env: { ...process.env, GITHUB_REPOSITORY: 'example/Norr', GITHUB_EVENT_NAME: 'schedule',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(readFileSync(output, 'utf8'), 'publish=false\n');
    assert.match(readFileSync(summary, 'utf8'), /\[skip release\]/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test('single-platform releases only satisfy their own platform and retain the correct baseline', () => {
  const full = { draft: false, sha: 'b'.repeat(40), tag_name: 'v0.1.0-alpha.10', published_at: '2026-11-14T00:00:00Z' };
  const ios = { draft: false, sha: initial.sha, tag_name: 'v0.1.0-alpha.11', published_at: '2026-11-14T01:00:00Z',
    body: '<!-- norr-release {"buildNumber":1011,"platform":"ios-ipa"} -->' };
  const input = { ...initial, releases: [full, ios] };
  assert.equal(planRelease({ ...input, platform: 'ios-ipa' }).publish, false);
  for (const platform of ['all', 'windows']) {
    const plan = planRelease({ ...input, platform });
    assert.equal(plan.publish, true);
    assert.equal(plan.previousTag, full.tag_name);
  }
  const windows = { ...ios, body: '<!-- norr-release {"buildNumber":1011,"platform":"windows"} -->' };
  assert.equal(planRelease({ ...initial, releases: [full, windows], platform: 'ios-ipa' }).previousTag, full.tag_name);
  assert.equal(planRelease({ ...initial, releases: [{ ...full, sha: initial.sha }], platform: 'ios-ipa' }).publish, false);
});

test('IPA-only release publishes Watch and no-Watch packages with distinct checksums and notes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-ipa-release-'));
  try {
    writeFileSync(join(directory, 'Norr-ios-arm64-unsigned.ipa'), 'ios-package-with-watch');
    assert.throws(() => prepareAssets('0.1.0-alpha.11', directory, 'ios-ipa'), /exactly one package in Norr-ios-arm64-no-watch-unsigned/);
    writeFileSync(join(directory, 'Norr-ios-arm64-no-watch-unsigned.ipa'), 'ios-package-without-watch');
    const files = prepareAssets('0.1.0-alpha.11', directory, 'ios-ipa');
    assert.deepEqual(files.map(file => file.name), [
      'Norr_0.1.0-alpha.11_ios-arm64-unsigned.ipa',
      'Norr_0.1.0-alpha.11_ios-arm64-no-watch-unsigned.ipa',
      'SHA256SUMS.txt',
    ]);
    assert.equal(readFileSync(files[0].path, 'utf8'), 'ios-package-with-watch');
    assert.equal(readFileSync(files[1].path, 'utf8'), 'ios-package-without-watch');
    assert.equal(readFileSync(files[2].path, 'utf8').trim().split('\n').length, 2);
    const plan = { ...planRelease({ ...initial, platform: 'ios-ipa' }), previousTag: 'v0.1.0-alpha.10' };
    const notes = renderNotes(plan, [], [], 'pepsing/Norr', 'https://github.com/pepsing/Norr/actions/runs/1');
    assert.match(notes, /ios-arm64-unsigned\.ipa.*含 Apple Watch/);
    assert.match(notes, /ios-arm64-no-watch-unsigned\.ipa.*保留 iOS 小组件、Siri 和快捷指令/);
    assert.doesNotMatch(notes, /macos-arm64.zip|windows-x64|simulator.zip|android-arm64/);
    assert.match(notes, /"platform":"ios-ipa"/);
    writeFileSync(join(directory, 'duplicate-ios-arm64-unsigned.ipa'), 'duplicate');
    assert.throws(() => prepareAssets('0.1.0-alpha.11', directory, 'ios-ipa'), /exactly one package/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow selects only the device build for IPA-only dispatches', () => {
  const workflow = readFileSync('.github/workflows/build.yml', 'utf8');
  const source = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  const directory = mkdtempSync(join(tmpdir(), 'norr-matrix-'));
  try {
    for (const platform of ['all', 'windows', 'ios-ipa']) {
      const output = join(directory, platform);
      execFileSync(process.execPath, ['--input-type=module'], { input: source,
        env: { ...process.env, RELEASE_PLATFORM: platform, GITHUB_OUTPUT: output } });
      const matrices = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const split = line.indexOf('=');
        return [line.slice(0, split), JSON.parse(line.slice(split + 1)).include];
      }));
      assert.equal(matrices.desktop_matrix.length, platform === 'all' ? 3 : platform === 'windows' ? 1 : 0);
      assert.deepEqual(matrices.ios_matrix.map(target => target.variant), platform === 'all' ? ['simulator', 'unsigned'] : platform === 'ios-ipa' ? ['unsigned'] : []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('every release links the current repository self-signing guide once', () => {
  assert.ok(readFileSync('docs/ios-self-signing.md', 'utf8').includes('NorrWidgets.appex'));
  for (const platform of ['all', 'windows', 'ios-ipa']) {
    const plan = { ...planRelease({ ...initial, platform }), previousTag: 'v0.1.0-alpha.1' };
    const notes = renderNotes(plan, [], [], 'example/Norr', 'https://github.com/example/Norr/actions/runs/1');
    const guide = 'https://github.com/example/Norr/blob/main/docs/ios-self-signing.md';
    assert.equal(notes.split(guide).length - 1, 1);
    assert.match(notes, /AltStore Classic、爱思助手/);
  }
});

test('release requires both Mac architectures, the iOS simulator, and both device IPAs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'norr-assets-'));
  try {
    const packages = [
      ['Norr-macos-arm64', 'macos-arm64.zip'],
      ['Norr-macos-x64', 'macos-x64.zip'],
      ['Norr-windows-x64', 'windows-x64-setup.exe'],
      ['Norr-android-arm64', 'android-arm64.apk'],
      ['Norr-ios-arm64-simulator', 'ios-arm64-simulator.zip'],
      ['Norr-ios-arm64-unsigned', 'ios-arm64-unsigned.ipa'],
      ['Norr-ios-arm64-no-watch-unsigned', 'ios-arm64-no-watch-unsigned.ipa'],
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
  assert.doesNotThrow(() => validateVersion('0.1.0', 1001));
  assert.throws(() => validateVersion('01.1.0', 1001));
  assert.throws(() => validateVersion('0.1.0-rc.1', 1001));
  assert.throws(() => validateVersion('0.1.0-alpha.0', 1001));
  assert.throws(() => validateVersion('0.1.0-alpha.1', 1000));
  assert.throws(() => validateVersion('0.1.0-alpha.1', 2_100_000_001));
});

test('stable promotion rebuilds the same alpha source with a higher native build number', () => {
  const alpha = { draft: false, sha: initial.sha, tag_name: 'v0.1.0-alpha.14',
    body: '<!-- norr-release {"buildNumber":1014} -->' };
  const plan = planRelease({ ...initial, releases: [alpha], stableVersion: '0.1.0' });
  assert.equal(plan.publish, true);
  assert.equal(plan.version, '0.1.0');
  assert.equal(plan.tag, 'v0.1.0');
  assert.equal(plan.buildNumber, 1015);
  assert.equal(plan.previousTag, alpha.tag_name);
  for (const platform of ['windows', 'ios-ipa']) {
    assert.throws(() => planRelease({ ...initial, stableVersion: '0.1.0', platform }), /all platforms/);
  }
  assert.throws(() => planRelease({ ...initial, stableVersion: '0.1.0-alpha.15' }), /plain version/);
});

test('stable retries preserve draft metadata and cannot overwrite a different source or tag', () => {
  const metadata = { sha: initial.sha, version: '0.1.0', buildNumber: 1015, previousTag: 'v0.1.0-alpha.14', platform: 'all' };
  const draft = { draft: true, tag_name: 'v0.1.0', body: `<!-- norr-release ${JSON.stringify(metadata)} -->` };
  const input = { ...initial, stableVersion: '0.1.0', releases: [draft] };
  assert.deepEqual(planRelease(input), { ...metadata, publish: true, tag: 'v0.1.0' });
  assert.equal(planRelease({ ...input, releases: [{ ...draft, draft: false }] }).publish, false);
  assert.throws(() => planRelease({ ...input, sha: 'b'.repeat(40) }), /another source/);
  assert.throws(() => planRelease({ ...initial, stableVersion: '0.1.0', tags: ['v0.1.0'] }), /tag already exists/);
  assert.throws(() => planRelease({ ...initial, stableVersion: '0.1.0', tags: ['v0.2.0'] }), /newer/);
  assert.throws(() => planRelease({ ...input, tags: ['v0.2.0'] }), /older/);
  assert.match(planRelease({ ...initial, releases: [draft] }).version, /-alpha\./);
});

test('nightly alpha releases advance beyond the latest stable version', () => {
  const stable = { draft: false, sha: 'b'.repeat(40), tag_name: 'v0.1.0',
    body: '<!-- norr-release {"buildNumber":1015,"platform":"all"} -->' };
  const input = { ...initial, releases: [stable], tags: ['v0.1.0'] };
  assert.equal(planRelease(input).version, '0.1.1-alpha.1');
  assert.equal(planRelease(input).buildNumber, 1016);
  assert.equal(planRelease({ ...input, sha: stable.sha }).publish, false);
  assert.equal(planRelease({ ...input, tags: ['v0.1.0', 'v0.1.1-alpha.2'] }).version, '0.1.1-alpha.3');
  assert.equal(planRelease({ ...input, baseVersion: '0.2.0' }).version, '0.2.0-alpha.1');
  assert.equal(planRelease({ ...input, tags: ['v0.9.0', 'v0.10.0'] }).version, '0.10.1-alpha.1');
});

test('stable notes retain the reviewed release summary and machine-readable metadata', () => {
  const plan = planRelease({ ...initial, stableVersion: '0.1.0' });
  const summary = readFileSync('docs/releases/0.1.0.md', 'utf8');
  const notes = renderNotes(plan, [], [], 'pepsing/Norr', 'https://github.com/pepsing/Norr/actions/runs/1', summary);
  assert.ok(notes.includes(summary.trim()));
  assert.match(notes, /首个正式版/);
  assert.doesNotMatch(notes, /首个 alpha/);
  assert.match(notes, /"version":"0.1.0"/);
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
    execFileSync(process.execPath, [resolve('scripts/release/version.mjs'), '0.1.0', '1015'], { cwd: directory });
    const stableConfig = JSON.parse(readFileSync(join(directory, 'apps/native/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(stableConfig.version, '0.1.0');
    assert.equal(stableConfig.bundle.android.versionCode, 1015);
    assert.equal(stableConfig.bundle.macOS.bundleVersion, '1015');
    assert.equal(stableConfig.bundle.iOS.bundleVersion, '1015');
    for (const path of ['', 'apps/web', 'apps/native']) {
      assert.equal(JSON.parse(readFileSync(join(directory, path, 'package.json'), 'utf8')).version, '0.1.0');
    }
    assert.match(readFileSync(join(directory, 'Cargo.lock'), 'utf8'), /name = "norr"\nversion = "0.1.0"/);
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
