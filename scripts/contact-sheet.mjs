// Contact sheet helper. Usage: node scripts/contact-sheet.mjs <out.jpg> <cell> <file...>
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const [out, cellArg, ...files] = process.argv.slice(2);
const cell = Number(cellArg);
const cols = Math.ceil(Math.sqrt(files.length));
const rows = Math.ceil(files.length / cols);
const canvas = createCanvas(cols * cell, rows * cell);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#888'; ctx.fillRect(0, 0, canvas.width, canvas.height);
for (const [i, f] of files.entries()) {
  const img = await loadImage(fs.readFileSync(f));
  const s = Math.min((cell - 6) / img.width, (cell - 6) / img.height);
  ctx.drawImage(img, (i % cols) * cell + 3, Math.floor(i / cols) * cell + 3, img.width * s, img.height * s);
}
fs.writeFileSync(out, canvas.toBuffer('image/jpeg', 85));
console.log(out);
