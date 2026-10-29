// Renders the app icons from public/icons/icon.svg (run: npm run icons).
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const dir = new URL('../public/icons/', import.meta.url);
const svg = readFileSync(new URL('icon.svg', dir), 'utf8');
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['favicon-32.png', 32]]) {
  writeFileSync(new URL(name, dir), new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}
// Maskable: Android crops icons to a circle or squircle, so shrink everything except the background
// into the central 80% safe zone.
const maskable = svg.replace(/(<rect[^>]*\/>)([\s\S]*)(<\/svg>)/, '$1<g transform="translate(256 256) scale(.8) translate(-256 -256)">$2</g>$3');
writeFileSync(new URL('icon-maskable-512.png', dir), new Resvg(maskable, { fitTo: { mode: 'width', value: 512 } }).render().asPng());
console.log('icons written');
