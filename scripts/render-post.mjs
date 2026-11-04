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

// A sold-out or mismatched product stops the render, so it can never reach a post.
function checkedProduct(productId, code) {
  const p = products.get(productId);
  if (!p) throw new Error(`Unknown product ${productId}`);
  if (p.status !== '판매중') throw new Error(`${p.name} is ${p.status}`);
  if (!p.name.includes(code)) throw new Error(`${code} does not match ${p.name}`);
  return p;
}

// Specs always come from the Imweb export.
const colors = source.colors.map((c) => {
  const p = checkedProduct(c.productId, c.code);
  if (c.pair) checkedProduct(c.pair.productId, c.pair.code);
  return {
    ...c,
    ko: field(p.summary, /색상\s*:\s*(\S+)/, 'colour'),
    size: field(p.summary, /사이즈\s*:\s*(\S+)/, 'size').replace(/x/i, '×'),
    finish: field(p.summary, /스펙\s*:\s*(.+?)\s*색상/, 'finish'),
    box: field(p.summary, /1BOX\s*=\s*(.+?)\s*사이즈/, 'box'),
  };
});

async function resize(file, outName, width) {
  const img = await loadImage(fs.readFileSync(file));
  const height = Math.round((img.height / img.width) * width);
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

// Native-resolution crop, so the macro shows the real surface rather than an upscale.
async function crop(file, outName, width, height) {
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(width, height);
  const sx = Math.round((img.width - width) / 2);
  const sy = Math.round((img.height - height) / 2);
  canvas.getContext('2d').drawImage(img, sx, sy, width, height, 0, 0, width, height);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

for (const c of colors) {
  await resize(path.join(source.sourceDir, c.face), `${c.name}.jpg`, 900);
  if (c.pair?.face) await resize(path.join(source.pairDir, c.pair.face), `${c.name}-pair.jpg`, 900);
  if (c.combo) await resize(path.join(source.sourceDir, c.combo), `${c.name}-combo.jpg`, 1080);
}
const surfaceColor = source.surface && colors.find((c) => c.name === source.surface.color);
if (surfaceColor) await crop(path.join(source.sourceDir, source.surface.face ?? surfaceColor.face), 'surface.jpg', W, H);

// Both tiles come from one combination image, so their tones stay comparable.
if (source.compare) {
  const c = colors.find((k) => k.name === source.compare.color);
  const img = await loadImage(fs.readFileSync(path.join(source.sourceDir, c.combo)));
  const tileW = Math.floor(img.width / 4) - 4;
  for (const [name, column] of [['compare-base', 0], ['compare-feature', 1]]) {
    const canvas = createCanvas(tileW, tileW * 2);
    canvas.getContext('2d').drawImage(img, Math.floor((img.width / 4) * column) + 2, 0, tileW, tileW * 2, 0, 0, tileW, tileW * 2);
    fs.writeFileSync(path.join(workDir, `${name}.jpg`), canvas.toBuffer('image/jpeg', 92));
  }
}
for (const [i, file] of (source.variants?.faces ?? []).entries()) {
  await resize(path.join(source.sourceDir, file), `variant-${i}.jpg`, 900);
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
    <div style="margin-top:14px;font-size:27px;font-weight:400">${source.intro}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:26px;font-weight:600;color:${INK}">${colors[0].size} · ${n} Colors</div>
  ${logo('logo-black.png', 104, 64, 60)}`);
}

function lineupSlide() {
  const cells = colors.map((c) => `<div>
    <div style="height:400px;background:url(${c.name}.jpg) center/cover"></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:18px">
      <span style="font-size:32px;font-weight:600;letter-spacing:-.01em">${c.name}</span>
      <span style="font-size:24px;font-weight:400">${c.ko}</span>
    </div>
    <div style="margin-top:6px;font-size:22px;font-weight:300">${c.code}</div>
  </div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:72px">
    <div style="font-size:50px;font-weight:300;letter-spacing:-.015em">${colors.length} Colors</div>
    <div style="margin-top:44px;display:grid;grid-template-columns:1fr 1fr;gap:40px 24px">${cells}</div>
  </div>
  ${logo('logo-black.png', 84, 64, 40)}`);
}

function surfaceSlide() {
  const { title, points } = source.surface;
  const list = points.map((p) => `<div style="margin-top:14px;font-size:29px;font-weight:400">${p}</div>`).join('');
  return page(`<img class="abs" src="surface.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:0;right:0;bottom:0;padding:48px 64px 56px;background:${PAPER}">
    <div style="font-size:48px;font-weight:600;letter-spacing:-.015em;margin-bottom:26px">${title}</div>
    ${list}
  </div>
  <div class="abs" style="left:64px;top:64px;background:${PAPER};padding:10px 18px;font-size:22px;font-weight:500">${surfaceColor.name} 표면 확대</div>
  ${logo('logo-black.png', 84, 64, 56)}`);
}

function pairingSlide() {
  const { color, title, body, baseName, featureName } = source.pairing;
  const c = colors.find((k) => k.name === color);
  const tileW = 430;
  const tile = (src, name, code) => `<div style="width:${tileW}px">
    <img src="${src}" style="display:block;width:${tileW}px;height:${tileW * 2}px;object-fit:cover">
    <div style="margin-top:18px;font-size:27px;font-weight:600">${name}</div>
    <div style="margin-top:4px;font-size:22px;font-weight:300">${code}</div>
  </div>`;
  return page(`<div class="abs" style="left:64px;right:64px;top:64px;text-align:center">
    <div style="font-size:48px;font-weight:600;letter-spacing:-.015em">${title}</div>
    <div style="margin-top:14px;font-size:27px;font-weight:400">${body}</div>
  </div>
  <div class="abs" style="left:0;right:0;top:204px;display:flex;justify-content:center;gap:16px">
    ${tile(`${c.name}-pair.jpg`, baseName, c.pair.code)}
    ${tile(`${c.name}.jpg`, featureName, c.code)}
  </div>
  ${logo('logo-black.png', 84, 64, 40)}`);
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

function colorCoverSlide() {
  const c = colors[0];
  return page(`<div class="abs" style="left:0;top:0;width:${W}px;height:${H}px;background:url(${c.name}.jpg) center/cover"></div>
  <div class="abs" style="left:64px;right:64px;top:72px">
    <div class="en" style="font-size:22px;font-weight:600">${source.collection}</div>
    <div style="margin-top:30px;font-size:132px;line-height:1.05;font-weight:300;letter-spacing:-.015em">${c.name}</div>
    <div style="margin-top:22px;font-size:34px;font-weight:500">${source.ko} ${c.ko}</div>
    <div style="margin-top:14px;font-size:27px;font-weight:400">${source.intro}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:26px;font-weight:600">${c.size} · ${c.code}</div>
  ${logo('logo-black.png', 104, 64, 60)}`);
}

function variantsSlide() {
  const { title, body, faces } = source.variants;
  const tileW = 322;
  const tiles = faces.map((_, i) => `<img src="variant-${i}.jpg" style="display:block;width:${tileW}px;height:${tileW * 2}px;object-fit:cover">`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:112px;text-align:center">
    <div style="font-size:48px;font-weight:600;letter-spacing:-.015em">${title}</div>
    <div style="margin-top:16px;font-size:27px;font-weight:400">${body}</div>
  </div>
  <div class="abs" style="left:0;right:0;top:330px;display:flex;justify-content:center;gap:16px">${tiles}</div>
  <div class="abs" style="left:40px;top:${330 + tileW * 2 + 20}px;font-size:23px;font-weight:400">${colors[0].code} · ${colors[0].size}</div>
  ${logo('logo-black.png', 84, 64, 40)}`);
}

function comboCoverSlide() {
  const c = colors.find((k) => k.name === source.coverColor);
  return page(`<img class="abs" src="${c.name}-combo.jpg" style="left:0;top:0;width:${W}px;height:${W}px">
  <div class="abs" style="left:64px;right:220px;top:${W + 34}px">
    <div class="en" style="font-size:20px;font-weight:600">${source.label}</div>
    <div style="margin-top:14px;font-size:50px;line-height:1.16;font-weight:300;letter-spacing:-.015em">${source.title}</div>
    <div style="margin-top:12px;font-size:25px;font-weight:400">${source.intro}</div>
  </div>
  ${logo('logo-black.png', 104, 64, 60)}`);
}

function compareSlide() {
  const { title, body, baseName, featureName } = source.compare;
  const c = colors.find((k) => k.name === source.compare.color);
  const tileW = 430;
  const tile = (src, name, code) => `<div style="width:${tileW}px">
    <img src="${src}" style="display:block;width:${tileW}px;height:${tileW * 2}px">
    <div style="margin-top:18px;font-size:27px;font-weight:600">${name}</div>
    <div style="margin-top:4px;font-size:22px;font-weight:300">${code}</div>
  </div>`;
  return page(`<div class="abs" style="left:64px;right:64px;top:64px;text-align:center">
    <div style="font-size:48px;font-weight:600;letter-spacing:-.015em">${title}</div>
    <div style="margin-top:14px;font-size:27px;font-weight:400">${body}</div>
  </div>
  <div class="abs" style="left:0;right:0;top:204px;display:flex;justify-content:center;gap:16px">
    ${tile('compare-base.jpg', baseName, c.pair.code)}
    ${tile('compare-feature.jpg', featureName, c.code)}
  </div>
  ${logo('logo-black.png', 84, 64, 40)}`);
}

function comboLargeSlide() {
  const c = colors.find((k) => k.name === source.largeColor);
  return page(`<img class="abs" src="${c.name}-combo.jpg" style="left:0;top:0;width:${W}px;height:${W}px">
  <div class="abs" style="left:64px;right:220px;top:${W + 44}px">
    <div style="font-size:50px;font-weight:600;letter-spacing:-.01em">${c.name}</div>
    <div style="margin-top:10px;font-size:27px;font-weight:400">${source.largeText}</div>
  </div>
  ${logo('logo-black.png', 84, 64, 54)}`);
}

function comboGridSlide() {
  const cells = colors.map((c) => `<div>
    <img src="${c.name}-combo.jpg" style="display:block;width:464px;height:464px">
    <div style="margin-top:14px;font-size:27px;font-weight:600">${c.name}</div>
  </div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:52px">
    <div style="font-size:44px;font-weight:600;letter-spacing:-.015em">${source.gridTitle}</div>
    <div style="margin-top:32px;display:grid;grid-template-columns:464px 464px;gap:24px">${cells}</div>
  </div>
  ${logo('logo-black.png', 84, 64, 34)}`);
}

function comboSpecSlide() {
  const c = colors[0];
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`]]
    .map(([k, v]) => `<div style="display:flex;padding:26px 0;border-bottom:1px solid rgba(244,242,237,.3);font-size:32px"><div style="width:250px;font-weight:300">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  const head = `<div style="display:grid;grid-template-columns:230px 1fr 1fr;font-size:23px;font-weight:300;margin-bottom:8px"><span>컬러</span><span>일반</span><span>스트라이프</span></div>`;
  const list = colors.map((k) => `<div style="display:grid;grid-template-columns:230px 1fr 1fr;align-items:center;padding:14px 0;font-size:25px"><span style="font-weight:600">${k.name}</span><span style="font-weight:300">${k.pair.code}</span><span style="font-weight:300">${k.code}</span></div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:80px">
    <div style="font-size:60px;font-weight:300;letter-spacing:-.015em;line-height:1.1">${source.specTitle}</div>
    <div style="margin-top:14px;font-size:30px;font-weight:500">${source.ko}</div>
    <div style="margin-top:46px;border-top:1px solid rgba(244,242,237,.3)">${rows}</div>
    <div style="margin-top:46px">${head}${list}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:30px;line-height:1.45"><span style="font-weight:300">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png', 150, 64, 64)}`, INK, PAPER);
}

const TEMPLATES = {
  color: () => [colorCoverSlide(), variantsSlide(), surfaceSlide(), specSlide()],
  combo: () => [comboCoverSlide(), compareSlide(), comboLargeSlide(), comboGridSlide(), comboSpecSlide()],
  collection: () => [coverSlide(), lineupSlide(), surfaceSlide(), pairingSlide(), specSlide()],
};
const slides = TEMPLATES[source.template ?? 'collection']();

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
