import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(project, '../..');
const studio = process.env.DEVECO_STUDIO_HOME || '/Applications/DevEco-Studio.app/Contents';
const tools = join(studio, 'tools');
const ohpm = join(tools, 'ohpm/bin/ohpm');
const hvigor = join(tools, 'hvigor/bin/hvigorw');
const sdk = process.env.DEVECO_SDK_HOME || join(studio, 'sdk');
for (const path of [ohpm, hvigor, sdk]) {
  if (!existsSync(path)) throw new Error(`Missing HarmonyOS toolchain path: ${path}`);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

let signingKey = process.env.NORR_POLESTAR_CN_SIGNING_KEY?.trim();
if (!signingKey) {
  const secrets = join(root, '.env.secrets');
  if (existsSync(secrets)) signingKey = parseEnv(readFileSync(secrets, 'utf8')).NORR_POLESTAR_CN_SIGNING_KEY?.trim();
}
if (!signingKey) throw new Error('构建登录版本需要 NORR_POLESTAR_CN_SIGNING_KEY。');
const nativeTools = join(sdk, 'default/openharmony/native/llvm/bin');
run('cargo', ['build', '-p', 'norr-harmonyos', '--target', 'aarch64-unknown-linux-ohos', '--release'], root, {
  ...process.env,
  NORR_POLESTAR_CN_SIGNING_KEY: signingKey,
  CC_aarch64_unknown_linux_ohos: join(nativeTools, 'aarch64-unknown-linux-ohos-clang'),
  CXX_aarch64_unknown_linux_ohos: join(nativeTools, 'aarch64-unknown-linux-ohos-clang++'),
  AR_aarch64_unknown_linux_ohos: join(nativeTools, 'llvm-ar'),
  CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER: join(nativeTools, 'aarch64-unknown-linux-ohos-clang'),
});
run('npm', ['run', 'build'], root);
const webResources = join(project, 'entry/src/main/resources/rawfile/web');
rmSync(webResources, { recursive: true, force: true });
cpSync(join(root, 'apps/web/dist'), webResources, { recursive: true });

const env = {
  ...process.env,
  DEVECO_SDK_HOME: sdk,
  NODE_HOME: join(tools, 'node'),
  JAVA_HOME: join(studio, 'jbr/Contents/Home'),
  PATH: `${join(tools, 'node/bin')}:${join(tools, 'ohpm/bin')}:${process.env.PATH}`,
};
run(ohpm, ['install'], project, env);
run(hvigor, [
  '--mode', 'module', '-p', 'product=default', '-p', 'module=entry@default',
  '-p', 'buildMode=release', 'assembleHap', '--no-daemon',
], project, env);

const output = join(project, 'entry/build/default/outputs/default');
const packages = readdirSync(output).filter(name => name.endsWith('.hap'));
if (packages.length === 0) throw new Error(`No HAP produced in ${output}`);
const destination = join(root, 'target/harmonyos');
mkdirSync(destination, { recursive: true });
for (const name of packages) {
  cpSync(join(output, name), join(destination, name));
  console.log(`HarmonyOS release: ${join(destination, name)}`);
}
