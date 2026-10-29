// Renders the app icons from public/icons/icon.svg (run: npm run icons).
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const dir = new URL('../public/icons/', import.meta.url);
const svg = readFileSync(new URL('icon.svg', dir), 'utf8');
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['favicon-32.png', 32]]) {
  writeFileSync(new URL(name, dir), new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}
console.log('icons written');
