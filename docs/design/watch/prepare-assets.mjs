import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
await mkdir(resolve(here, 'assets'), { recursive: true });
const files = [
  ['apps/web/public/images/vehicles/polestar-2/long-dual/snow-black-side-cutout.webp', 'vehicle.webp'],
  ['node_modules/@fontsource/archivo/files/archivo-latin-400-normal.woff2', 'archivo.woff2'],
  ['licenses/archivo-OFL.txt', 'archivo-OFL.txt'],
  ['licenses/lucide.txt', 'lucide.txt'],
];
const manifest = { date: '2026-11-17', purpose: 'Norr Watch design review only', assets: [] };
for (const [source, name] of files) {
  const bytes = await readFile(resolve(root, source));
  await copyFile(resolve(root, source), resolve(here, 'assets', name));
  manifest.assets.push({ file: name, source, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const name of ['Fan', 'LockKeyhole', 'LockKeyholeOpen', 'ChevronLeft', 'ChevronRight', 'RefreshCw', 'PlugZap', 'WifiOff', 'Check', 'Smartphone', 'CircleAlert', 'Minus', 'Plus']) {
  const svg = renderToStaticMarkup(React.createElement(icons[name], { size: 24, color: '#eeefe9', strokeWidth: 1.5 }));
  await writeFile(resolve(here, 'assets', `${name}.svg`), svg);
  manifest.assets.push({ file: `${name}.svg`, source: `lucide-react@1.72.0 / ${name}`, sha256: createHash('sha256').update(svg).digest('hex') });
}
manifest.vehicleRights = 'Unmodified existing Polestar asset. Original sources and rights status remain in apps/web/public/images/vehicles/manifest.json. Public redistribution permission has not been verified.';
await writeFile(resolve(here, 'assets/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Prepared ${manifest.assets.length} existing assets.`);
