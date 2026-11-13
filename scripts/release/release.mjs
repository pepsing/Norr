import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateVersion } from './version.mjs';

const marker = /<!-- norr-release (\{[^\n]+\}) -->/;
const packages = [
  ['Norr-macos-arm64', '.zip', 'macos-arm64.zip', 'Apple Silicon Mac，解压后安装 Norr.app'],
  ['Norr-macos-x64', '.zip', 'macos-x64.zip', 'Intel Mac，解压后安装 Norr.app'],
  ['Norr-windows-x64', '-setup.exe', 'windows-x64-setup.exe', 'Windows 10/11 x64 安装程序'],
  ['Norr-android-arm64', '.apk', 'android-arm64.apk', 'Android ARM64，沿用当前测试证书'],
  ['Norr-ios-arm64-simulator', '-simulator.zip', 'ios-arm64-simulator.zip', 'Apple Silicon Mac 上的 iOS 模拟器'],
  ['Norr-ios-arm64-unsigned', '-unsigned.ipa', 'ios-arm64-unsigned.ipa', 'iPhone / iPad 真机包，安装前需使用有效证书与描述文件重新签名'],
];

function releasePackages(platform = 'all') {
  if (!['all', 'windows'].includes(platform)) throw new Error('Invalid release platform');
  return packages.filter(([artifact]) => platform === 'all' || artifact === 'Norr-windows-x64');
}

export function releaseMetadata(release) {
  const match = release.body?.match(marker);
  return match ? JSON.parse(match[1]) : undefined;
}

export function planRelease({ sha, baseVersion, releases, tags, platform = 'all' }) {
  releasePackages(platform);
  const published = releases.filter((release) => !release.draft)
    .sort((left, right) => Date.parse(right.published_at ?? 0) - Date.parse(left.published_at ?? 0));
  const previous = published.find((release) => platform === 'windows'
    || (releaseMetadata(release)?.platform ?? 'all') === 'all');
  if (previous?.sha === sha) return { publish: false, sha };
  const pending = releases.find((release) => release.draft && releaseMetadata(release)?.sha === sha
    && (releaseMetadata(release)?.platform ?? 'all') === platform);
  if (pending) {
    const metadata = releaseMetadata(pending);
    validateVersion(metadata.version, metadata.buildNumber);
    return { ...metadata, platform, publish: true, tag: pending.tag_name };
  }
  const prefix = `v${baseVersion}-alpha.`;
  const numbers = [...tags, ...releases.map((release) => release.tag_name)]
    .filter((tag) => tag.startsWith(prefix) && /^[1-9]\d*$/.test(tag.slice(prefix.length)))
    .map((tag) => Number(tag.slice(prefix.length)));
  const version = `${baseVersion}-alpha.${Math.max(0, ...numbers) + 1}`;
  const buildNumber = Math.max(1000, ...releases.map((release) => releaseMetadata(release)?.buildNumber ?? 0)) + 1;
  validateVersion(version, buildNumber);
  return { publish: true, sha, version, buildNumber, platform, tag: `v${version}`, previousTag: previous?.tag_name ?? '' };
}

export function referencedIssues(text, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`https://github\\.com/${escaped}/issues/(\\d+)|(?:^|[\\s(])#(\\d+)`, 'g');
  return [...new Set([...text.matchAll(pattern)].map((match) => Number(match[1] ?? match[2])))];
}

function markdownText(text) {
  return text.replace(/\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/gi, '')
    .replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>]/g, '\\$&').replaceAll('@', '@\u200b');
}

export function renderNotes(plan, changes, issues, repository, runUrl) {
  const lines = [`Norr ${plan.version}，构建号 ${plan.buildNumber}。`, '', '## 本版更新', ''];
  if (!plan.previousTag) {
    lines.push(
      '- 首个 alpha 版本，提供中国区 Polestar 2 短信登录、车辆状态、远程控制、充电日程与本地历史。',
      '- 包含共享账号能力判断、控制状态高亮、指令局部回读、高德地图默认展示，以及手机控制页布局修复。',
      '- 提供 macOS、Windows、Android 与 iOS 模拟器测试包，Polestar 4 的车辆服务接入仍待完成。',
      '',
    );
  }
  for (const change of changes) {
    lines.push(`- ${markdownText(change.title)}。${change.url ? ` [${change.label}](${change.url})` : ''}`);
  }
  lines.push('', '## 关联 issue', '');
  if (issues.length === 0) lines.push('本版改动尚未关联 issue。');
  for (const issue of issues) {
    lines.push(`- #${issue.number} ${markdownText(issue.title)}（${issue.state === 'closed' ? '已关闭' : '待确认'}）。[查看问题](${issue.html_url})`);
  }
  lines.push('', '## 安装包', '',
    '| 文件后缀 | 适用平台 |', '| --- | --- |',
    ...releasePackages(plan.platform).map(([, , suffix, description]) => `| \`${suffix}\` | ${description} |`),
    '', '附件中的 `SHA256SUMS.txt` 提供文件校验值。',
    plan.platform === 'windows' ? 'Windows 安装包尚未进行代码签名。'
      : 'macOS 使用 ad-hoc 签名，Windows 代码签名与各端正式分发签名仍待完成。',
    '', '本版通过所选平台的自动测试与构建，新包的登录、系统功能和实车操作按进度表继续验收。',
    '', `[构建记录](${runUrl}) · [验证范围](https://github.com/${repository}/blob/${plan.sha}/docs/PROGRESS.md)`,
  );
  if (plan.previousTag) {
    lines.push('', `[完整改动](https://github.com/${repository}/compare/${plan.previousTag}...${plan.tag})`);
  }
  lines.push('', `<!-- norr-release ${JSON.stringify({ sha: plan.sha, version: plan.version, buildNumber: plan.buildNumber, previousTag: plan.previousTag, platform: plan.platform ?? 'all' })} -->`, '');
  return lines.join('\n');
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function api(path, method = 'GET', body) {
  const args = ['api', path, '--method', method];
  if (body !== undefined) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function pages(path) {
  return JSON.parse(execFileSync('gh', ['api', path, '--paginate', '--slurp'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })).flat();
}

function getReleases(repository) {
  return pages(`repos/${repository}/releases?per_page=100`).map((release) => {
    if (release.draft) return release;
    return { ...release, sha: git('rev-parse', '--verify', `refs/tags/${release.tag_name}^{commit}`) };
  });
}

function collectChanges(plan, repository) {
  const revision = plan.previousTag ? `${plan.previousTag}..${plan.sha}` : plan.sha;
  const commits = git('log', '--reverse', '--format=%H', revision).split('\n').filter(Boolean);
  const changes = [];
  const issueNumbers = new Set();
  const seenPulls = new Set();
  for (const sha of commits) {
    const message = git('show', '-s', '--format=%B', sha);
    for (const number of referencedIssues(message, repository)) issueNumbers.add(number);
    const pulls = pages(`repos/${repository}/commits/${sha}/pulls?per_page=100`)
      .filter((pull) => pull.merged_at && pull.base.repo.full_name === repository && pull.base.ref === 'main');
    if (pulls.length === 0) {
      changes.push({ title: message.split('\n')[0], label: sha.slice(0, 7), url: `https://github.com/${repository}/commit/${sha}` });
    }
    for (const pull of pulls) {
      if (seenPulls.has(pull.number)) continue;
      seenPulls.add(pull.number);
      changes.push({ title: pull.title, label: `PR #${pull.number}`, url: pull.html_url });
      for (const number of referencedIssues(`${pull.title}\n${pull.body ?? ''}`, repository)) issueNumbers.add(number);
      const query = `query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100,after:$endCursor){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}`;
      const [owner, name] = repository.split('/');
      const linked = JSON.parse(execFileSync('gh', ['api', 'graphql', '--paginate', '--slurp',
        '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pull.number}`,
      ], { encoding: 'utf8' }));
      for (const page of linked) {
        for (const issue of page.data.repository.pullRequest.closingIssuesReferences.nodes) {
          if (issue.repository.nameWithOwner === repository) issueNumbers.add(issue.number);
        }
      }
    }
  }
  const issues = [];
  for (const number of [...issueNumbers].sort((a, b) => a - b)) {
    try {
      const issue = api(`repos/${repository}/issues/${number}`);
      if (!issue.pull_request) issues.push(issue);
    } catch (error) {
      if (!String(error.stderr).includes('HTTP 404')) throw error;
      console.warn(`Issue #${number} is unavailable, omitting its reference.`);
    }
  }
  return { changes, issues };
}

export function prepareAssets(version, directory, platform = 'all') {
  const patterns = releasePackages(platform);
  const output = join(directory, 'release');
  mkdirSync(output, { recursive: true });
  const files = [];
  for (const [artifact, extension, suffix] of patterns) {
    const folder = join(directory, artifact);
    const candidates = readdirSync(folder).filter((name) => name.endsWith(extension));
    if (candidates.length !== 1) throw new Error(`Expected exactly one package in ${artifact}`);
    const path = join(output, `Norr_${version}_${suffix}`);
    copyFileSync(join(folder, candidates[0]), path);
    files.push(path);
  }
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const checksums = join(output, 'SHA256SUMS.txt');
  writeFileSync(checksums, files.map((path) => `${digest(path)}  ${path.split('/').at(-1)}`).join('\n') + '\n');
  files.push(checksums);
  return files.map((path) => ({ path, name: path.split('/').at(-1), size: readFileSync(path).length, digest: `sha256:${digest(path)}` }));
}

function publishRelease(plan, repository, directory) {
  validateVersion(plan.version, plan.buildNumber);
  if (plan.tag !== `v${plan.version}` || git('rev-parse', 'HEAD') !== plan.sha) throw new Error('Release source mismatch');
  const files = prepareAssets(plan.version, directory, plan.platform);
  let release = getReleases(repository).find((item) => item.tag_name === plan.tag);
  if (release && (releaseMetadata(release)?.sha !== plan.sha
      || (releaseMetadata(release)?.platform ?? 'all') !== (plan.platform ?? 'all'))) {
    throw new Error('Release tag belongs to different source or platform');
  }
  if (!release || release.draft) {
    const { changes, issues } = collectChanges(plan, repository);
    const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const body = renderNotes(plan, changes, issues, repository, runUrl);
    const payload = { tag_name: plan.tag, target_commitish: plan.sha, name: `Norr ${plan.version}`, body, draft: true, prerelease: true, make_latest: 'false' };
    release = release
      ? api(`repos/${repository}/releases/${release.id}`, 'PATCH', payload)
      : api(`repos/${repository}/releases`, 'POST', payload);
    execFileSync('gh', ['release', 'upload', plan.tag, ...files.map((file) => file.path), '--repo', repository, '--clobber'], { stdio: 'inherit' });
  }
  release = api(`repos/${repository}/releases/${release.id}`);
  for (const file of files) {
    const asset = release.assets.find((item) => item.name === file.name);
    if (!asset || asset.size !== file.size || asset.digest !== file.digest) throw new Error(`Release asset verification failed: ${file.name}`);
  }
  if (release.draft) release = api(`repos/${repository}/releases/${release.id}`, 'PATCH', { draft: false, prerelease: true, make_latest: 'false' });
  console.log(release.html_url);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `发布完成 [${plan.tag}](${release.html_url})，包含 ${files.length - 1} 个安装包及 SHA256SUMS.txt。\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid GitHub repository');
  if (process.argv[2] === 'plan') {
    const baseVersion = JSON.parse(readFileSync('package.json', 'utf8')).version.split('-')[0];
    const releases = getReleases(repository);
    const plan = planRelease({ sha: git('rev-parse', 'HEAD'), baseVersion, releases,
      tags: git('tag', '--list').split('\n'), platform: process.env.NORR_RELEASE_PLATFORM ?? 'all' });
    for (const [name, value] of Object.entries(plan)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, plan.publish
      ? `准备发布 ${plan.tag}，平台 ${plan.platform}，源提交 ${plan.sha}。\n`
      : `所选平台与上次成功发布的提交一致，跳过构建和发布。\n`);
  } else if (process.argv[2] === 'publish') {
    const outputs = JSON.parse(process.env.NORR_RELEASE_PLAN);
    publishRelease({ ...outputs, buildNumber: Number(outputs.build_number), previousTag: outputs.previous_tag }, repository, process.argv[3]);
  } else {
    throw new Error('Expected plan or publish');
  }
}
