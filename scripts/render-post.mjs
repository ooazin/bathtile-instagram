// Renders a collection's carousel to posts/<slug>/images/*.jpg and writes post.json as a draft.
// Usage: node scripts/render-post.mjs <slug>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium } from 'playwright-core';

const W = 1080;
const H = 1350;
const INK = '#1d1c1a';
const PAPER = '#f4f2ed';

const slug = process.argv[2];
if (!slug) throw new Error('Usage: node scripts/render-post.mjs <slug>');

const postDir = path.resolve('posts', slug);
const workDir = path.resolve('work', slug);
const outDir = path.join(postDir, 'images');
fs.mkdirSync(workDir, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const source = JSON.parse(fs.readFileSync(path.join(postDir, 'source.json'), 'utf8'));
const products = new Map(JSON.parse(fs.readFileSync('data/products.json', 'utf8')).map((p) => [p.id, p]));

const field = (summary, re, label) => {
  const m = summary.match(re);
  if (!m) throw new Error(`Missing ${label} in: ${summary}`);
  return m[1].trim();
};

// Specs always come from the Imweb export, and a sold-out colour stops the render.
const colors = source.colors.map((c) => {
  const p = products.get(c.productId);
  if (!p) throw new Error(`Unknown product ${c.productId}`);
  if (p.status !== '판매중') throw new Error(`${p.name} is ${p.status}`);
  if (!p.name.includes(c.code)) throw new Error(`${c.code} does not match ${p.name}`);
  return {
    ...c,
    ko: field(p.summary, /색상\s*:\s*(.+)$/, 'colour'),
    size: field(p.summary, /사이즈\s*:\s*(\S+)/, 'size').replace(/x/i, '×'),
    finish: field(p.summary, /스펙\s*:\s*(.+?)\s*색상/, 'finish'),
    box: field(p.summary, /1BOX\s*=\s*(.+?)\s*사이즈/, 'box'),
  };
});

async function resize(file, outName, width) {
  const img = await loadImage(fs.readFileSync(path.join(source.sourceDir, file)));
  const height = Math.round((img.height / img.width) * width);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

// Native-resolution crop, so the macro shows the real surface rather than an upscale.
async function crop(file, outName, size) {
  const img = await loadImage(fs.readFileSync(path.join(source.sourceDir, file)));
  const canvas = createCanvas(size, size);
  const sx = Math.round((img.width - size) / 2);
  const sy = Math.round((img.height - size) / 2);
  canvas.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, size, size);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

for (const c of colors) {
  await resize(c.face, `${c.name}.jpg`, 700);
  await crop(c.face, `${c.name}-macro.jpg`, 784);
}

const assetUrl = (file) => pathToFileURL(path.resolve('assets', file)).href;
const fontFaces = [[300, '3Light'], [400, '4Regular'], [500, '5Medium'], [600, '6SemiBold'], [700, '7Bold']]
  .map(([weight, file]) => `@font-face{font-family:Paperlogy;src:url("${assetUrl(`fonts/Paperlogy-${file}.woff2`)}");font-weight:${weight}}`)
  .join('');

const page = (body, bg = PAPER, color = INK) => `<!doctype html><meta charset="utf-8"><style>
${fontFaces}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${bg};color:${color};font-family:Paperlogy}
.abs{position:absolute}.en{letter-spacing:.14em;text-transform:uppercase}
</style>${body}`;

const logo = (file, width, right, bottom) => `<img class="abs" src="${assetUrl(file)}" style="right:${right}px;bottom:${bottom}px;width:${width}px;opacity:.5">`;

function coverSlide() {
  const n = colors.length;
  const strip = W / n;
  const strips = colors.map((c, i) => `<div class="abs" style="left:${i * strip}px;top:0;width:${strip}px;height:${H}px;background:url(${c.name}.jpg) center/cover;border-right:${i < n - 1 ? 3 : 0}px solid #fff"></div>`).join('');
  const [first, ...rest] = source.collection.split(' ');
  return page(`${strips}
  <div class="abs" style="left:64px;right:64px;top:72px;color:${INK}">
    <div class="en" style="font-size:22px;font-weight:600">${source.label}</div>
    <div style="margin-top:30px;font-size:104px;line-height:1.08;font-weight:300;letter-spacing:-.015em">${first}${rest.length ? `<br>${rest.join(' ')}` : ''}</div>
    <div style="margin-top:26px;font-size:34px;font-weight:500">${source.ko}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:26px;font-weight:600;color:${INK}">${colors[0].size} · ${n} Colors</div>
  ${logo('logo-black.png', 104, 64, 60)}`);
}

function colorSlide(c, i) {
  const tileW = 540;
  const tileTop = 66;
  const macro = 384;
  const macroTop = tileTop + tileW * 2 - macro;
  return page(`<img class="abs" src="${c.name}.jpg" style="left:56px;top:${tileTop}px;width:${tileW}px;height:${tileW * 2}px;object-fit:cover;box-shadow:0 18px 44px rgba(29,28,26,.22)">
  <div class="abs" style="left:640px;right:56px;top:${tileTop}px">
    <div class="en" style="font-size:22px;font-weight:500">${String(i + 1).padStart(2, '0')} / ${String(colors.length).padStart(2, '0')}</div>
    <div style="margin-top:52px;font-size:60px;line-height:1.05;font-weight:600;letter-spacing:-.01em">${c.name}</div>
    <div style="margin-top:16px;font-size:32px;font-weight:400">${c.ko}</div>
    <div style="margin-top:36px;font-size:24px;line-height:1.6;font-weight:400">${c.code}<br>${c.size}</div>
  </div>
  <div class="abs" style="left:640px;top:${macroTop - 44}px;font-size:23px;font-weight:500">표면 확대</div>
  <img class="abs" src="${c.name}-macro.jpg" style="left:640px;top:${macroTop}px;width:${macro}px;height:${macro}px">
  <div class="abs" style="left:56px;bottom:62px;font-size:24px;font-weight:500">${source.collection}</div>
  ${logo('logo-black.png', 84, 56, 54)}`);
}

function specSlide() {
  const c = colors[0];
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`]]
    .map(([k, v]) => `<div style="display:flex;padding:30px 0;border-bottom:1px solid rgba(244,242,237,.3);font-size:34px"><div style="width:250px;font-weight:300">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  const lineup = colors.map((k) => `<div style="display:flex;align-items:center;gap:26px;font-size:27px"><img src="${k.name}.jpg" style="width:64px;height:64px;object-fit:cover"><span style="width:200px;font-weight:600">${k.name}</span><span style="font-weight:300">${k.code}</span></div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:80px">
    <div style="font-size:66px;font-weight:300;letter-spacing:-.015em;line-height:1.1">${source.collection}</div>
    <div style="margin-top:14px;font-size:32px;font-weight:500">${source.ko}</div>
    <div style="margin-top:50px;border-top:1px solid rgba(244,242,237,.3)">${rows}</div>
    <div style="margin-top:50px;display:grid;gap:20px">${lineup}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:30px;line-height:1.45"><span style="font-weight:300">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png', 150, 64, 64)}`, INK, PAPER);
}

const slides = [coverSlide(), ...colors.map(colorSlide), specSlide()];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
const tab = await browser.newPage({ viewport: { width: W, height: H } });
const images = [];
for (const [i, html] of slides.entries()) {
  const name = `${String(i + 1).padStart(2, '0')}.jpg`;
  const htmlPath = path.join(workDir, `slide-${i + 1}.html`);
  fs.writeFileSync(htmlPath, html);
  await tab.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({ path: path.join(outDir, name), type: 'jpeg', quality: 90 });
  images.push(`images/${name}`);
}
await browser.close();

// Re-rendering resets a post to draft, so changed images always need a fresh approval.
const postPath = path.join(postDir, 'post.json');
const previous = fs.existsSync(postPath) ? JSON.parse(fs.readFileSync(postPath, 'utf8')) : {};
if (previous.status === 'published') throw new Error(`${slug} is already published`);
fs.writeFileSync(postPath, `${JSON.stringify({ slug, status: 'draft', scheduled_at: previous.scheduled_at ?? null, caption: source.caption, images }, null, 2)}\n`);
console.log(`Rendered ${images.length} slides to ${outDir}`);
