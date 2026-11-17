import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mime = { '.woff2': 'font/woff2', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const manifest = JSON.parse(await readFile(resolve(here, 'assets/manifest.json'), 'utf8'));
const embedded = new Map();
for (const { file } of manifest.assets) {
  if (!mime[extname(file)]) continue;
  const data = await readFile(resolve(here, 'assets', file));
  embedded.set(`assets/${file}`, `data:${mime[extname(file)]};base64,${data.toString('base64')}`);
}
let css = await readFile(resolve(here, 'design.css'), 'utf8');
let js = await readFile(resolve(here, 'design.js'), 'utf8');
for (const [path, data] of embedded) css = css.replaceAll(path, data);
js = `const bundledAssets = ${JSON.stringify(Object.fromEntries(embedded))};\n` + js;
js = js.replace('src="assets/${name}.svg"', 'src="${bundledAssets[`assets/${name}.svg`]}"');
js = js.replace("const asset = 'assets/vehicle.webp';", "const asset = bundledAssets['assets/vehicle.webp'];");
const html = (await readFile(resolve(here, 'index.html'), 'utf8'))
  .replace('<link rel="stylesheet" href="design.css">', `<style>${css}</style>`)
  .replace(/^[ \t]*<script src="design.js" defer><\/script>\r?\n/m, '')
  .replace('</body>', `<script>${js}</script></body>`);
await writeFile(resolve(here, 'norr-watch-design.html'), html);
console.log(`Standalone design: ${Buffer.byteLength(html)} bytes, ${embedded.size} embedded assets.`);
