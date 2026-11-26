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
// Matches Instagram's dark post panel, so dark slides sit flush beside the caption.
const DARK = '#212328';

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

const specOf = (p) => ({
  size: field(p.summary, /사이즈\s*:\s*(\S+)/, 'size').replace(/x/i, '×'),
  box: field(p.summary, /1BOX\s*=\s*(\S+\s*=\s*\S+)/, 'box'),
});

// Specs always come from the Imweb export.
const colors =source.colors.map((c) => {
  const p = checkedProduct(c.productId, c.code);
  if (c.pair) checkedProduct(c.pair.productId, c.pair.code);
  return {
    ...c,
    ko: field(p.summary, /색상\s*:\s*(.+?)(?:\s+원산지|$)/, 'colour'),
    size: field(p.summary, /사이즈\s*:\s*(\S+)/, 'size').replace(/x/i, '×'),
    finish: field(p.summary, /스펙\s*:\s*(.+?)\s*색상/, 'finish'),
    box: field(p.summary, /1BOX\s*=\s*(\S+\s*=\s*\S+)/, 'box'),
    large: c.large && { ...c.large, ...specOf(checkedProduct(c.large.productId, c.large.code)) },
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
  if (c.large) await resize(path.join(source.sourceDir, c.large.face), `${c.name}-large.jpg`, 1000);
}
const surfaceColor = source.surface && colors.find((c) => c.name === source.surface.color);
if (surfaceColor) await crop(path.join(source.sourceDir, source.surface.face ?? surfaceColor.face), 'surface.jpg', W, H);

function boxBlur(values, width, height, radius) {
  let out = values;
  for (let pass = 0; pass < 3; pass++) {
    const across = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += out[y * width + Math.min(width - 1, Math.max(0, x))];
      for (let x = 0; x < width; x++) {
        across[y * width + x] = sum / (2 * radius + 1);
        sum += out[y * width + Math.min(width - 1, x + radius + 1)] - out[y * width + Math.max(0, x - radius)];
      }
    }
    const down = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += across[Math.min(height - 1, Math.max(0, y)) * width + x];
      for (let y = 0; y < height; y++) {
        down[y * width + x] = sum / (2 * radius + 1);
        sum += across[Math.min(height - 1, y + radius + 1) * width + x] - across[Math.max(0, y - radius) * width + x];
      }
    }
    out = down;
  }
  return out;
}

// Lights a mold map from one side on a dark ground. The map is cropped from the centre,
// which leaves out the factory code printed in its corner.
async function moldRelief(file, outName, { cropW, cropH, width, height, lightX, lightY, reach, base = 0.1, gain = 1.9 }) {
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.width - cropW) / 2, (img.height - cropH) / 2, cropW, cropH, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = (pixels.data[i * 4] + pixels.data[i * 4 + 1] + pixels.data[i * 4 + 2]) / 3;
  const low = boxBlur(gray, width, height, Math.max(4, Math.round(width / 28)));
  for (let i = 0; i < gray.length; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const light = Math.max(0.3, 1 - Math.hypot(x - lightX, y - lightY) / reach);
    const level = Math.max(0, Math.min(1, base + ((gray[i] - low[i]) / 128) * gain * light)) * 255;
    pixels.data[i * 4] = level;
    pixels.data[i * 4 + 1] = level * 0.975;
    pixels.data[i * 4 + 2] = level * 0.93;
  }
  ctx.putImageData(pixels, 0, 0);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

if (source.mold) {
  const a = path.join(source.sourceDir, source.mold.a);
  const b = path.join(source.sourceDir, source.mold.b);
  await moldRelief(a, 'relief-cover.jpg', { cropW: 2400, cropH: 3000, width: W, height: H, lightX: 280, lightY: 320, reach: 1250 });
  // The comparison shows the mold maps untouched, cropped from the centre.
  await crop(a, 'mold-a.jpg', 2400, 2400);
  await crop(b, 'mold-b.jpg', 2400, 2400);
  for (const c of colors) await crop(path.join(source.sourceDir, c.relief), `${c.name}-relief.jpg`, 1400, 1400);
}

// A maker's room image, cropped to 4:5 from the bottom so the floor stays in frame.
async function coverCrop(file, outName) {
  const img = await loadImage(fs.readFileSync(file));
  const sw = Math.min(img.width, Math.round((img.height * W) / H));
  const sh = Math.round((sw * H) / W);
  const canvas = createCanvas(W, H);
  canvas.getContext('2d').drawImage(img, (img.width - sw) / 2, img.height - sh, sw, sh, 0, 0, W, H);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

// A fixed window of a source image, scaled to the slide size.
async function cropRegion(file, outName, [sx, sy, sw, sh], width, height) {
  const img = await loadImage(fs.readFileSync(file));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, width, height);
  fs.writeFileSync(path.join(workDir, outName), canvas.toBuffer('image/jpeg', 92));
}

for (const f of source.family ?? []) {
  checkedProduct(f.productId, f.code);
  await resize(path.join(source.sourceDir, f.face), `family-${f.name}.jpg`, 300);
}
for (const n of source.variations?.picks ?? []) {
  await resize(path.join(source.sourceDir, source.variations.file.replace('{n}', n)), `variation-${n}.jpg`, 600);
}
for (const c of colors) {
  if (c.detail) await resize(path.join(source.sourceDir, c.detail), `${c.name}-detail.jpg`, 900);
  if (c.scene) await resize(path.join(source.sourceDir, c.scene), `${c.name}-scene.jpg`, 1000);
}
if (source.space) await cropRegion(path.join(source.sourceDir, source.space.file), 'space.jpg', source.space.crop, W, source.space.full ? H : 620);
// The zoom circle shows the tile face at its own resolution, not an enlargement.
if (source.space?.zoom) await crop(path.join(source.sourceDir, colors[0].face), 'zoom.jpg', source.space.zoom, source.space.zoom);
if (source.scene && source.sceneCrop) await cropRegion(path.join(source.sourceDir, source.scene), 'scene.jpg', source.sceneCrop, W, H);
else if (source.scene) await coverCrop(path.join(source.sourceDir, source.scene), 'scene.jpg');
if (source.prints) {
  for (let n = 1; n <= source.prints.count; n++) {
    await resize(path.join(source.sourceDir, source.prints.file.replace('{n}', n)), `print-${n}.jpg`, 240);
  }
  // Mold maps shown untouched, cropped from the centre away from the factory code.
  await crop(path.join(source.sourceDir, source.prints.moldA), 'mold-a.jpg', 2400, 2400);
  await crop(path.join(source.sourceDir, source.prints.moldB), 'mold-b.jpg', 2400, 2400);
}

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

// Mood images: a given crop, or the largest centred area of the target shape.
async function moodCrop(entry, outName, width, height) {
  const file = path.resolve(source.sourceDir, entry.file);
  let rect = entry.crop;
  if (!rect) {
    const img = await loadImage(fs.readFileSync(file));
    const w = Math.min(img.width, Math.round((img.height * width) / height));
    const h = Math.round((w * height) / width);
    rect = [Math.round((img.width - w) / 2), Math.round((img.height - h) / 2), w, h];
  }
  await cropRegion(file, outName, rect, width, height);
}
for (const a of source.assets ?? []) await moodCrop(a, a.out, a.w ?? W, a.h ?? H);
for (const [i, m] of (source.mood ?? []).entries()) {
  if (m.split) {
    for (const [k, part] of m.split.entries()) await moodCrop(part, `mood-${i}-${k}.jpg`, W, H / 2);
  } else {
    await moodCrop(m, `mood-${i}.jpg`, W, H);
  }
}

const assetUrl = (file) => pathToFileURL(path.resolve('assets', file)).href;
const fontUrl = pathToFileURL(path.resolve('node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2')).href;

const page = (body, bg = PAPER, color = INK) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Pretendard;src:url("${fontUrl}");font-weight:45 920}
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${bg};color:${color};font-family:Pretendard}
.abs{position:absolute}.en{letter-spacing:.14em;text-transform:uppercase}
</style>${body}`;

// Same size and position on every slide.
const logo = (file) => `<img class="abs" src="${assetUrl(file)}" style="right:64px;bottom:56px;width:84px;opacity:.5">`;

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
  ${logo('logo-black.png')}`);
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
  ${logo('logo-black.png')}`);
}

function surfaceSlide() {
  const { title, points } = source.surface;
  const list = points.map((p) => `<div style="margin-top:14px;font-size:29px;font-weight:400">${p}</div>`).join('');
  return page(`<img class="abs" src="surface.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:0;right:0;bottom:0;padding:48px 64px 56px;background:${PAPER}">
    <div style="font-size:48px;font-weight:600;letter-spacing:-.015em;margin-bottom:26px">${title}</div>
    ${list}
  </div>
  <div class="abs" style="left:64px;top:64px;background:${PAPER};padding:10px 18px;font-size:22px;font-weight:500">${source.surface.label ?? surfaceColor.name} 표면 확대</div>
  ${logo('logo-black.png')}`);
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
  ${logo('logo-black.png')}`);
}

function specSlide() {
  const c = colors[0];
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`]]
    .map(([k, v]) => `<div style="display:flex;padding:30px 0;border-bottom:1px solid rgba(244,242,237,.3);font-size:34px"><div style="width:250px;font-weight:300">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  // A single colour gets a large swatch with its name and code stacked beside it.
  const lineup = colors.length === 1
    ? colors.map((k) => `<div style="display:flex;align-items:flex-end;gap:36px"><img src="${k.name}.jpg" style="width:400px;height:400px;object-fit:cover"><div><div style="font-size:44px;font-weight:700">${k.name}</div><div style="margin-top:8px;font-size:28px;font-weight:300">${k.ko} · ${k.code}</div></div></div>`).join('')
    : colors.map((k) => `<div style="display:flex;align-items:center;gap:26px;font-size:27px"><img src="${k.name}.jpg" style="width:64px;height:64px;object-fit:cover"><span style="width:200px;font-weight:600">${k.name}</span><span style="font-weight:300">${k.code}</span></div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:80px">
    <div style="font-size:66px;font-weight:300;letter-spacing:-.015em;line-height:1.1">${source.collection}</div>
    <div style="margin-top:14px;font-size:32px;font-weight:500">${source.ko}</div>
    <div style="margin-top:50px;border-top:1px solid rgba(244,242,237,.3)">${rows}</div>
    <div style="margin-top:50px;display:grid;gap:20px">${lineup}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;font-size:30px;line-height:1.45"><span style="font-weight:300">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
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
  ${logo('logo-black.png')}`);
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
  ${logo('logo-black.png')}`);
}

function comboCoverSlide() {
  const c = colors.find((k) => k.name === source.coverColor);
  return page(`<img class="abs" src="${c.name}-combo.jpg" style="left:0;top:0;width:${W}px;height:${W}px">
  <div class="abs" style="left:64px;right:220px;top:${W + 34}px">
    <div class="en" style="font-size:20px;font-weight:600">${source.label}</div>
    <div style="margin-top:14px;font-size:50px;line-height:1.16;font-weight:300;letter-spacing:-.015em">${source.title}</div>
    <div style="margin-top:12px;font-size:25px;font-weight:400">${source.intro}</div>
  </div>
  ${logo('logo-black.png')}`);
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
  ${logo('logo-black.png')}`);
}

function comboLargeSlide() {
  const c = colors.find((k) => k.name === source.largeColor);
  return page(`<img class="abs" src="${c.name}-combo.jpg" style="left:0;top:0;width:${W}px;height:${W}px">
  <div class="abs" style="left:64px;right:220px;top:${W + 44}px">
    <div style="font-size:50px;font-weight:600;letter-spacing:-.01em">${c.name}</div>
    <div style="margin-top:10px;font-size:27px;font-weight:400">${source.largeText}</div>
  </div>
  ${logo('logo-black.png')}`);
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
  ${logo('logo-black.png')}`);
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
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function moldCoverSlide() {
  const chip = W / colors.length;
  const chips = colors.map((c, i) => `<div class="abs" style="left:${i * chip}px;bottom:0;width:${chip}px;height:${chip}px;background:url(${c.name}.jpg) center/100% 100%"></div>`).join('');
  return page(`<img class="abs" src="relief-cover.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:56px;top:64px;font-size:62px;line-height:1.2;font-weight:700;letter-spacing:-.03em">${source.hook}</div>
  <div class="abs" style="left:54px;right:40px;bottom:${chip + 92}px;font-size:190px;line-height:1;font-weight:800;letter-spacing:-.035em">${source.collection}</div>
  <div class="abs" style="left:60px;bottom:${chip + 44}px;font-size:30px;font-weight:500">${source.ko} · ${source.intro}</div>
  ${chips}
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function moldConceptSlide() {
  const { title, body, groups } = source.mold;
  const size = 308;
  const cell = ([mold, turn]) => `<div style="position:relative;width:${size}px;height:${size}px;overflow:hidden">
    <img src="mold-${mold}.jpg" style="display:block;width:${size}px;height:${size}px;transform:rotate(${turn}deg)">
    <span class="abs" style="left:12px;top:6px;font-size:32px;font-weight:800;color:#fff">${mold.toUpperCase()}</span>
  </div>`;
  const group = ({ label, cells }) => `<div style="font-size:27px;font-weight:700;margin:22px 0 12px">${label}</div>
    <div style="display:grid;grid-template-columns:repeat(3,${size}px);gap:6px">${cells.map(cell).join('')}</div>`;
  return page(`<div class="abs" style="left:68px;right:68px;top:44px">
    <div style="font-size:50px;font-weight:700;letter-spacing:-.025em">${title}</div>
    <div style="margin-top:10px;font-size:27px;font-weight:400">${body}</div>
    ${groups.map(group).join('')}
  </div>
  ${logo('logo-black.png')}`);
}

// Each colour runs as a diagonal band of its own relief image; colour is not adjusted.
function surfaceBandsSlide() {
  const n = colors.length;
  const slope = 150;
  const step = (H + slope) / n;
  const angle = (Math.atan(slope / W) * 180) / Math.PI;
  const bands = colors.map((c, i) => {
    const y = (k) => k * step;
    const points = `0 ${y(i)}px,100% ${y(i) - slope}px,100% ${y(i + 1) - slope}px,0 ${y(i + 1)}px`;
    const shade = i < 2 || c.name === 'FOG' ? INK : PAPER;
    return `<div class="abs" style="inset:0;background:url(${c.name}-relief.jpg) center/cover;clip-path:polygon(${points})"></div>
    <div class="abs" style="left:56px;top:${y(i) + 26}px;color:${shade};transform:rotate(-${angle}deg);transform-origin:left top;font-size:32px;font-weight:700;letter-spacing:.02em">${c.name}</div>`;
  }).join('');
  return page(`${bands}${logo('logo-white.png')}`);
}

function sceneCoverSlide() {
  const c = colors[0];
  return page(`<img class="abs" src="scene.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:0;right:0;bottom:0;height:560px;background:linear-gradient(transparent,rgba(20,19,18,.72))"></div>
  <div class="abs" style="left:60px;right:200px;bottom:60px;color:${PAPER}">
    <div style="font-size:112px;line-height:1;font-weight:650;letter-spacing:-.03em">${source.collection} ${c.name}</div>
    <div style="margin-top:20px;font-size:30px;font-weight:500">${source.ko} ${c.ko} · ${c.size} · ${c.finish.replace(/[()]/g, '').replace(/\s+/, ' ')}</div>
  </div>
  ${logo('logo-white.png')}`);
}

function printsMoldsSlide() {
  const { title, body, note } = source.prints;
  const n = source.prints.count;
  const prints = Array.from({ length: n }, (_, i) => `<img src="print-${i + 1}.jpg" style="display:block;width:115px;height:115px">`).join('');
  const mold = (k) => `<div style="position:relative;width:350px;height:350px"><img src="mold-${k}.jpg" style="display:block;width:350px;height:350px"><span class="abs" style="left:14px;top:6px;font-size:40px;font-weight:800;color:#fff">${k.toUpperCase()}</span></div>`;
  const label = (text) => `<div style="font-size:27px;font-weight:700;margin-bottom:14px">${text}</div>`;
  return page(`<div class="abs" style="left:56px;right:56px;top:56px">
    <div style="font-size:60px;line-height:1.2;font-weight:700;letter-spacing:-.025em">${title}</div>
    <div style="margin-top:14px;font-size:28px;font-weight:400">${body}</div>
    <div style="margin-top:64px">${label(`디자인 프린팅 ${n}가지`)}<div style="display:grid;grid-template-columns:repeat(8,115px);gap:6px">${prints}</div></div>
    <div style="margin:26px 0 0;font-size:64px;font-weight:300;line-height:1">×</div>
    <div style="margin-top:20px;display:flex;align-items:flex-end;gap:6px">
      <div>${label('몰드 2가지')}<div style="display:flex;gap:6px">${mold('a')}${mold('b')}</div></div>
      <div style="margin-left:34px;padding-bottom:8px"><div style="font-size:64px;font-weight:300;line-height:1">=</div><div style="font-size:150px;line-height:1;font-weight:800;letter-spacing:-.04em">${n * 2}</div><div style="font-size:30px;font-weight:600">가지 표면</div></div>
    </div>
    <div style="margin-top:48px;font-size:27px;font-weight:400">${note}</div>
  </div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Editorial series: a short accent rule marks each section, tile-square markers point out features.
function edHeader(color) {
  return `<div class="abs en" style="left:64px;top:58px;display:flex;align-items:center;gap:14px;font-size:18px;font-weight:600;color:${color}">
    <span style="width:28px;height:2px;background:currentColor"></span>${source.header ?? `${source.collection} ${colors[0].name}`}</div>`;
}

function edHeadline([light, bold], accent) {
  const strong = bold.replace(/<em>(.+?)<\/em>/g, `<span style="color:${accent}">$1</span>`);
  return `<div style="font-size:56px;line-height:1.28;letter-spacing:-.02em"><div style="font-weight:300">${light}</div><div style="font-weight:600">${strong}</div></div>`;
}

const edLabel = (text, color) => `<div style="display:inline-block;font-size:19px;font-weight:600;color:${color};border-bottom:2px solid ${color};padding-bottom:4px;margin-bottom:20px">${text}</div>`;
const edSquare = (color, size = 16) => `<span style="display:inline-block;width:${size}px;height:${size}px;background:${color};flex:none"></span>`;

function edCoverSlide() {
  const c = colors[0];
  const { label, line } = source.cover;
  return page(`<img class="abs" src="scene.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  ${edHeader(INK)}
  <div class="abs" style="left:64px;right:220px;bottom:64px">
    ${edLabel(label, source.accent.onLight)}
    <div style="font-size:84px;line-height:1;font-weight:500;letter-spacing:-.025em">${source.collection} ${c.name}</div>
    <div style="margin-top:20px;font-size:30px;font-weight:400">${line}</div>
    <div style="margin-top:14px;font-size:22px;font-weight:400">${source.ko} ${c.ko} · ${c.size} · 포세린 무광</div>
  </div>
  ${logo('logo-black.png')}`);
}

function edSurfaceSlide() {
  const { label, lines, marks, body } = source.surface;
  const mark = ({ text, x, y }) => `<div class="abs" style="left:${x}px;top:${y}px;display:flex;align-items:center;gap:12px;font-size:22px;font-weight:500">
    ${edSquare(INK, 14)}<span style="border-bottom:1px solid ${INK};padding-bottom:2px">${text}</span></div>`;
  return page(`<img class="abs" src="surface.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  ${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:132px">${edLabel(label, INK)}${edHeadline(lines, INK)}</div>
  ${marks.map(mark).join('')}
  <div class="abs" style="left:64px;right:220px;bottom:64px;font-size:24px;line-height:1.6;font-weight:400">${body}</div>
  ${logo('logo-black.png')}`);
}

function edSpaceSlide() {
  const { label, lines, tag, points } = source.space;
  const cols = points.map(([title, text], i) => `<div style="flex:1;padding:0 26px;${i ? 'border-left:1px solid rgba(244,242,237,.18)' : 'padding-left:0'}">
    ${edSquare(source.accent.onDark, 18)}
    <div style="margin-top:18px;font-size:25px;font-weight:600">${title}</div>
    <div style="margin-top:10px;font-size:20px;line-height:1.55;font-weight:400;opacity:.8">${text}</div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:132px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <img class="abs" src="space.jpg" style="left:0;top:430px;width:${W}px;height:620px">
  <div class="abs" style="left:24px;top:454px;background:rgba(29,28,26,.6);color:${PAPER};padding:6px 14px;border-radius:16px;font-size:17px;font-weight:500">${tag}</div>
  <div class="abs" style="left:64px;right:200px;top:1102px;display:flex">${cols}</div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function edPrintsSlide() {
  const { label, lines, body, picks } = source.variations;
  const size = picks.length > 2 ? 400 : 470;
  const cells = picks.map((n) => `<div><img src="variation-${n}.jpg" style="display:block;width:${size}px;height:${size}px">
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px;font-size:19px;font-weight:500">${edSquare(source.accent.onLight, 12)}프린팅 ${String(n).padStart(2, '0')}</div></div>`).join('');
  return page(`${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:118px">${edLabel(label, source.accent.onLight)}${edHeadline(lines, source.accent.onLight)}
    <div style="margin-top:14px;font-size:22px;font-weight:400">${body}</div></div>
  <div class="abs" style="left:64px;top:404px;display:grid;grid-template-columns:${size}px ${size}px;gap:12px">${cells}</div>
  ${logo('logo-black.png')}`);
}

// Tone scale: the post's colour shown wider among its neighbours, light to dark.
function edToneSlide() {
  const { label, lines, body, order } = source.tone;
  const c = colors[0];
  const gap = 10;
  const narrow = 180;
  const wide = W - 128 - narrow * (order.length - 1) - gap * (order.length - 1);
  const band = (name) => {
    const f = source.family.find((k) => k.name === name);
    const own = name === c.name;
    return `<div style="width:${own ? wide : narrow}px">
      <div style="height:600px;background:url(family-${name}.jpg) center/cover"></div>
      <div style="margin-top:16px;display:flex;align-items:center;gap:10px;font-size:${own ? 24 : 19}px;font-weight:${own ? 700 : 500}">${own ? edSquare(source.accent.onLight, 12) : ''}${name}</div>
      ${own ? `<div style="margin-top:6px;font-size:19px;font-weight:400">${c.ko} · ${f.code}</div>` : ''}
    </div>`;
  };
  return page(`${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:118px">${edLabel(label, source.accent.onLight)}${edHeadline(lines, source.accent.onLight)}
    <div style="margin-top:14px;font-size:22px;font-weight:400">${body}</div></div>
  <div class="abs" style="left:64px;right:64px;top:420px;display:flex;gap:${gap}px">${order.map(band).join('')}</div>
  ${logo('logo-black.png')}`);
}

// Full room image with a magnified circle of the real tile face.
function edSpaceZoomSlide() {
  const { label, lines, tag, zoom, zoomAt: [x, y] } = source.space;
  return page(`<img class="abs" src="space.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  ${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:118px">${edLabel(label, source.accent.onLight)}${edHeadline(lines, source.accent.onLight)}</div>
  <div class="abs" style="left:${x}px;top:${y}px;width:${zoom}px;height:${zoom}px;border-radius:50%;background:url(zoom.jpg) center/cover;box-shadow:0 0 0 6px ${PAPER},0 18px 40px rgba(0,0,0,.18)"></div>
  <div class="abs" style="left:${x}px;top:${y + zoom + 28}px;width:${zoom}px;text-align:center;font-size:21px;font-weight:600">${colors[0].name} 표면 확대</div>
  <div class="abs" style="left:24px;bottom:24px;background:rgba(29,28,26,.55);color:${PAPER};padding:6px 14px;border-radius:16px;font-size:17px;font-weight:500">${tag}</div>
  ${logo('logo-black.png')}`);
}

// Collection cover: a dark room image with the colour range along the bottom.
function kzCoverSlide() {
  const chips = colors.map((c) => `<div style="width:104px"><div style="height:104px;background:url(${c.name}.jpg) center/cover;box-shadow:0 0 0 1px rgba(244,242,237,.35)"></div>
    <div style="margin-top:10px;font-size:17px;font-weight:600">${c.name}</div></div>`).join('');
  return page(`<img class="abs" src="scene.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  ${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:132px;color:${PAPER}">
    ${edLabel(source.cover.label, PAPER)}
    <div style="font-size:96px;line-height:1;font-weight:500;letter-spacing:-.02em">${source.collection}</div>
    <div style="margin-top:22px;font-size:30px;font-weight:400">${source.cover.line}</div>
  </div>
  <div class="abs" style="left:64px;bottom:64px;display:flex;gap:14px;color:${PAPER}">${chips}</div>
  ${logo('logo-white.png')}`);
}

// Close-up photographs of the real tiles, one per colour.
function kzDetailSlide() {
  const { label, lines, body } = source.detail;
  const size = 420;
  const cells = colors.map((c) => `<div><img src="${c.name}-detail.jpg" style="display:block;width:${size}px;height:${size}px;object-fit:cover">
    <div style="margin-top:10px;display:flex;align-items:center;gap:10px;font-size:19px;font-weight:600">${edSquare(source.accent.onLight, 12)}${c.name}<span style="font-weight:400">${c.ko}</span></div></div>`).join('');
  return page(`${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onLight)}${edHeadline(lines, source.accent.onLight)}
    <div style="margin-top:12px;font-size:22px;font-weight:400">${body}</div></div>
  <div class="abs" style="left:64px;top:392px;display:grid;grid-template-columns:${size}px ${size}px;gap:14px 12px">${cells}</div>
  ${logo('logo-black.png')}`);
}

// One room image per colour.
function kzScenesSlide() {
  const { label, lines, tag } = source.scenes;
  const w = 470;
  const h = 420;
  const cells = colors.map((c) => `<div style="position:relative"><img src="${c.name}-scene.jpg" style="display:block;width:${w}px;height:${h}px;object-fit:cover">
    <div class="abs" style="left:14px;bottom:12px;background:rgba(29,28,26,.6);padding:5px 12px;border-radius:14px;font-size:17px;font-weight:600">${c.name}</div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <div class="abs" style="left:64px;top:366px;display:grid;grid-template-columns:${w}px ${w}px;gap:12px">${cells}</div>
  <div class="abs" style="left:64px;top:${366 + h * 2 + 28}px;font-size:18px;font-weight:500;opacity:.7">${tag}</div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Both sizes per colour on one scale, with their codes.
function kzSizesSlide() {
  const { label, lines } = source.sizes;
  const unit = 170;
  const row = (c) => `<div style="display:flex;align-items:flex-end;gap:22px;padding:18px 0;border-top:1px solid rgba(29,28,26,.14)">
    <div style="width:190px;padding-bottom:4px"><div style="font-size:26px;font-weight:700">${c.name}</div><div style="margin-top:4px;font-size:19px">${c.ko}</div></div>
    <div><img src="${c.name}.jpg" style="display:block;width:${unit}px;height:${unit}px;object-fit:cover"><div style="margin-top:8px;font-size:16px">${c.size} · ${c.code}</div></div>
    <div><img src="${c.name}-large.jpg" style="display:block;width:${unit * 2}px;height:${unit}px;object-fit:cover"><div style="margin-top:8px;font-size:16px">${c.large.size} · ${c.large.code}</div></div>
  </div>`;
  return page(`${edHeader(INK)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onLight)}${edHeadline(lines, source.accent.onLight)}</div>
  <div class="abs" style="left:64px;right:64px;top:330px">${colors.map(row).join('')}</div>
  ${logo('logo-black.png')}`);
}

function kzSpecSlide() {
  const c = colors[0];
  const rows = [['구분·마감', c.finish], [c.size, `1BOX ${c.box}`], [c.large.size, `1BOX ${c.large.box}`], ['컬러', colors.map((k) => k.name).join(' · ')]]
    .map(([k, v]) => `<div style="display:flex;padding:24px 0;border-bottom:1px solid rgba(244,242,237,.18);font-size:27px"><div style="width:240px;font-weight:300;opacity:.8">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:132px">
    ${edLabel('제품 사양', source.accent.onDark)}
    <div style="font-size:64px;font-weight:500;letter-spacing:-.02em">${source.collection}</div>
    <div style="margin-top:8px;font-size:27px;font-weight:400;opacity:.85">${source.ko}</div>
    <div style="margin-top:48px;border-top:1px solid rgba(244,242,237,.18)">${rows}</div>
    <div style="margin-top:56px;display:flex;gap:16px">${colors.map((k) => `<div style="flex:1"><div style="height:150px;background:url(${k.name}-large.jpg) center/cover"></div>
      <div style="margin-top:10px;font-size:19px;font-weight:600">${k.name}<span style="margin-left:8px;font-weight:300;opacity:.8">${k.ko}</span></div></div>`).join('')}</div>
  </div>
  <div class="abs" style="left:64px;bottom:60px;font-size:24px;line-height:1.5"><span style="font-weight:300;opacity:.8">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function edSpecSlide() {
  const c = colors[0];
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`], ['품번', c.code]]
    .map(([k, v]) => `<div style="display:flex;padding:22px 0;border-bottom:1px solid rgba(244,242,237,.18);font-size:26px"><div style="width:220px;font-weight:300;opacity:.8">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  const family = source.family ? `<div class="abs" style="left:64px;right:64px;top:760px">
    ${edLabel(`${source.collection} 컬러 ${source.family.length}종`, source.accent.onDark)}
    <div style="display:flex;gap:12px">${source.family.map((f) => `<div style="width:148px">
      <img src="family-${f.name}.jpg" style="display:block;width:148px;height:148px;${f.name === c.name ? `outline:3px solid ${source.accent.onDark};outline-offset:4px` : ''}">
      <div style="margin-top:14px;font-size:19px;font-weight:${f.name === c.name ? 700 : 400}">${f.name}</div></div>`).join('')}</div>
  </div>` : '';
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:132px">
    ${edLabel('제품 사양', source.accent.onDark)}
    <div style="font-size:56px;font-weight:500;letter-spacing:-.02em">${source.collection} ${c.name}</div>
    <div style="margin-top:8px;font-size:26px;font-weight:400;opacity:.85">${source.ko} ${c.ko}</div>
    <div style="margin-top:40px;display:flex;gap:44px;align-items:flex-start">
      <img src="${c.name}.jpg" style="display:block;width:330px;height:330px;object-fit:cover">
      <div style="flex:1;border-top:1px solid rgba(244,242,237,.18)">${rows}</div>
    </div>
  </div>
  ${family}
  <div class="abs" style="left:64px;bottom:60px;font-size:24px;line-height:1.5"><span style="font-weight:300;opacity:.8">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function sizesSlide() {
  const unit = 248; // px per 600mm, so both formats share one scale
  const both = colors.filter((c) => c.large);
  const single = colors.filter((c) => !c.large);
  const label = (text) => `<div style="margin-top:8px;font-size:21px;font-weight:400">${text}</div>`;
  const row = (c) => `<div style="display:flex;gap:18px;align-items:flex-start;margin-top:26px">
    <div style="width:170px;padding-top:4px"><div style="font-size:30px;font-weight:600">${c.name}</div><div style="margin-top:4px;font-size:22px;font-weight:400">${c.ko}</div></div>
    <div><img src="${c.name}.jpg" style="display:block;width:${unit}px;height:${unit}px;object-fit:cover">${label(c.size)}</div>
    <div><img src="${c.name}-large.jpg" style="display:block;width:${unit * 2}px;height:${unit}px;object-fit:cover">${label(c.large.size)}</div>
  </div>`;
  const smallW = 226;
  const small = single.map((c) => `<div style="width:${smallW}px"><img src="${c.name}.jpg" style="display:block;width:${smallW}px;height:${smallW}px;object-fit:cover">
    <div style="margin-top:10px;font-size:26px;font-weight:600">${c.name}</div><div style="margin-top:2px;font-size:20px;font-weight:400">${c.ko} · ${c.size}</div></div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:64px">
    <div style="font-size:46px;font-weight:600;letter-spacing:-.015em">${source.sizesTitle}</div>
    ${both.map(row).join('')}
    <div style="margin-top:32px;border-top:1px solid rgba(29,28,26,.25);padding-top:26px;display:flex;justify-content:space-between">${small}</div>
  </div>
  ${logo('logo-black.png')}`);
}

function sizesSpecSlide() {
  const specs = new Map(colors.flatMap((c) => [[c.size, c.box], ...(c.large ? [[c.large.size, c.large.box]] : [])]));
  const rows = [...specs].map(([size, box]) => [size, `1BOX ${box}`]);
  rows.unshift(['구분·마감', colors[0].finish]);
  const table = rows.map(([k, v]) => `<div style="display:flex;padding:22px 0;border-bottom:1px solid rgba(244,242,237,.3);font-size:30px"><div style="width:250px;font-weight:300">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  const sizes = [...specs.keys()];
  const grid = 'display:grid;grid-template-columns:200px 1fr 1fr;align-items:center';
  const head = `<div style="${grid};font-size:22px;font-weight:300;margin-bottom:6px"><span>컬러</span>${sizes.map((s) => `<span>${s}</span>`).join('')}</div>`;
  const list = colors.map((c) => `<div style="${grid};padding:11px 0;font-size:24px"><span style="font-weight:600">${c.name}</span><span style="font-weight:300">${c.code}</span><span style="font-weight:300">${c.large?.code ?? '-'}</span></div>`).join('');
  return page(`<div class="abs" style="left:64px;right:64px;top:72px">
    <div style="font-size:64px;font-weight:300;letter-spacing:-.015em;line-height:1.1">${source.collection}</div>
    <div style="margin-top:12px;font-size:30px;font-weight:500">${source.ko}</div>
    <div style="margin-top:36px;border-top:1px solid rgba(244,242,237,.3)">${table}</div>
    <div style="margin-top:38px">${head}${list}</div>
  </div>
  <div class="abs" style="left:64px;bottom:60px;font-size:30px;line-height:1.45"><span style="font-weight:300">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Image-led slides with as little type as possible: a small spaced title, or just a colour name.
function moodSlide(i) {
  const m = source.mood[i];
  const ink = m.tone === 'light' ? INK : PAPER;
  const shade = m.tone === 'light' ? '' : '<div class="abs" style="left:0;top:0;right:0;height:420px;background:linear-gradient(rgba(0,0,0,.28),rgba(0,0,0,0))"></div>';
  const title = m.title || m.line ? `<div class="abs" style="left:0;right:0;top:${m.titleTop ?? 120}px;text-align:center;color:${ink}">
    ${m.title ? `<div style="font-size:54px;font-weight:300;letter-spacing:.32em;padding-left:.32em">${m.title}</div>` : ''}
    ${m.line ? `<div style="margin-top:${m.title ? 20 : 0}px;font-size:${m.title ? 22 : 30}px;font-weight:${m.title ? 400 : 300};letter-spacing:.06em">${m.line}</div>` : ''}</div>` : '';
  const tag = (text, bottom) => `<div class="abs en" style="left:64px;bottom:${bottom}px;font-size:17px;font-weight:500;color:${ink}">${text}</div>`;
  const label = m.label ? tag(m.label, 66) : '';
  const img = (src, top, height, filter) => `<img class="abs" src="${src}" style="left:0;top:${top}px;width:${W}px;height:${height}px;${filter ? `filter:${filter}` : ''}">`;
  const images = m.split
    ? m.split.map((p, k) => img(`mood-${i}-${k}.jpg`, (k * H) / 2, H / 2, p.filter)).join('')
      + `<div class="abs" style="left:0;right:0;top:${H / 2 - 1}px;height:2px;background:${PAPER}"></div>`
      + m.split.map((p, k) => (p.label ? tag(p.label, k === 0 ? H / 2 + 30 : 66) : '')).join('')
    : img(`mood-${i}.jpg`, 0, H, m.filter);
  return page(`${images}
  ${m.title || m.line ? shade : ''}${title}${label}
  ${logo(m.tone === 'light' ? 'logo-black.png' : 'logo-white.png')}`);
}

// Single-product feed: one colour in one size.
const single = () => ({ c: colors[0], title: `${source.collection} ${colors[0].name}` });

function sgCoverSlide() {
  const { c, title } = single();
  return page(`<img class="abs" src="cover.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:0;top:0;right:0;height:460px;background:linear-gradient(rgba(0,0,0,.32),rgba(0,0,0,0))"></div>
  <div class="abs" style="left:64px;top:96px;color:${PAPER}">
    <div class="en" style="font-size:18px;font-weight:600">${c.size}</div>
    <div style="margin-top:18px;font-size:72px;line-height:1;font-weight:400;letter-spacing:-.01em">${title}</div>
    <div style="margin-top:18px;font-size:26px;font-weight:400">${source.ko} ${c.ko}</div>
  </div>
  ${logo('logo-white.png')}`);
}

function sgDetailSlide() {
  const { label, lines, body } = source.detail;
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}
    <div style="margin-top:12px;font-size:22px;font-weight:400;opacity:.8">${body}</div></div>
  <img class="abs" src="detail.jpg" style="left:64px;top:380px;width:952px;height:840px;object-fit:cover">
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function sgFacesSlide() {
  const { label, lines, body, picks } = source.faces;
  const w = 466;
  const h = 233;
  const rows = Math.ceil(picks.length / 2);
  const cells = picks.map((n) => `<img src="face-${n}.jpg" style="display:block;width:${w}px;height:${h}px;object-fit:cover">`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <div class="abs" style="left:64px;top:350px;display:grid;grid-template-columns:${w}px ${w}px;gap:20px">${cells}</div>
  <div class="abs" style="left:64px;right:220px;top:${350 + rows * (h + 20) + 24}px;font-size:22px;line-height:1.6;font-weight:400">${body}</div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function sgSpaceSlide() {
  const { label, lines, tag } = source.spaceWide;
  return page(`<img class="abs" src="space-wide.jpg" style="left:0;top:0;width:${W}px;height:900px">
  <div class="abs" style="left:64px;right:64px;top:960px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}
    <div style="margin-top:16px;font-size:20px;font-weight:500;opacity:.7">${tag}</div></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function sgSpecSlide() {
  const { c, title } = single();
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`], ['품번', c.code]]
    .map(([k, v]) => `<div style="display:flex;padding:22px 0;border-bottom:1px solid rgba(244,242,237,.18);font-size:26px"><div style="width:190px;font-weight:300;opacity:.8">${k}</div><div style="font-weight:500">${v}</div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;top:132px">
    ${edLabel('제품 사양', source.accent.onDark)}
    <div style="font-size:60px;font-weight:500;letter-spacing:-.02em">${title}</div>
    <div style="margin-top:8px;font-size:26px;font-weight:400">${source.ko} ${c.ko}</div>
  </div>
  <img class="abs" src="${c.name}.jpg" style="left:64px;top:400px;width:300px;height:600px;object-fit:cover">
  <div class="abs" style="left:420px;right:64px;top:400px;border-top:1px solid rgba(244,242,237,.18)">${rows}</div>
  <div class="abs" style="left:64px;bottom:60px;font-size:24px;line-height:1.5"><span style="font-weight:300;opacity:.8">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Light cover image with the title in ink at the top left.
function s2CoverSlide() {
  const { c, title } = single();
  return page(`<img class="abs" src="cover.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs" style="left:64px;${source.coverAt === 'bottom' ? 'bottom:150px' : 'top:96px'};color:${INK}">
    <div class="en" style="font-size:18px;font-weight:600">${c.size}</div>
    <div style="margin-top:18px;font-size:72px;line-height:1;font-weight:400;letter-spacing:-.01em">${title}</div>
    <div style="margin-top:18px;font-size:26px;font-weight:400">${source.ko} ${c.ko}</div>
  </div>
  ${logo('logo-black.png')}`);
}

// One room, then a wall area marked on it, then the tile face at its own resolution.
function s2ZoomSlide() {
  const { label, lines, view, wall, steps } = source.zoom;
  const top = 340;
  const roomH = Math.round((952 * view[3]) / view[2]);
  const k = 952 / view[2];
  const mark = [64 + (wall[0] - view[0]) * k, top + (wall[1] - view[1]) * k, wall[2] * k, wall[3] * k].map(Math.round);
  const lowTop = top + roomH + 64;
  const panel = (src, x, text) => `<div class="abs" style="left:${x}px;top:${lowTop}px"><img src="${src}" style="display:block;width:466px;height:330px;object-fit:cover">
    <div style="margin-top:12px;font-size:19px;font-weight:500;opacity:.85">${text}</div></div>`;
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <img class="abs" src="room.jpg" style="left:64px;top:${top}px;width:952px;height:${roomH}px">
  <div class="abs" style="left:${mark[0]}px;top:${mark[1]}px;width:${mark[2]}px;height:${mark[3]}px;border:2px solid ${PAPER}"></div>
  <svg class="abs" style="left:0;top:0" width="${W}" height="${H}"><path d="M${mark[0]} ${mark[1] + mark[3]} L64 ${lowTop} M${mark[0] + mark[2]} ${mark[1] + mark[3]} L530 ${lowTop}" stroke="${PAPER}" stroke-width="1.5" opacity=".6" fill="none"/></svg>
  <div class="abs" style="left:64px;top:${top + roomH + 14}px;font-size:19px;font-weight:500;opacity:.85">${steps[0]}</div>
  ${panel('wall.jpg', 64, steps[1])}${panel('face-zoom.jpg', 550, steps[2])}
  ${logo('logo-white.png')}`, DARK, PAPER);
}

function s2FullSlide() {
  const { c, title } = single();
  return page(`<img class="abs" src="full.jpg" style="left:0;top:0;width:${W}px;height:${H}px">
  <div class="abs en" style="left:64px;bottom:66px;font-size:17px;font-weight:500;color:${source.fullTone === 'dark' ? PAPER : INK}">${title} · ${c.size}</div>
  ${logo(source.fullTone === 'dark' ? 'logo-white.png' : 'logo-black.png')}`);
}

// Spec with the whole tile face across the top.
function s2SpecSlide() {
  const { c, title } = single();
  const rows = [['규격', c.size], ['구분·마감', c.finish], ['포장', `1BOX ${c.box}`], ['품번', c.code]]
    .map(([k, v]) => `<div style="padding:20px 0;border-top:1px solid rgba(244,242,237,.18)"><div style="font-size:19px;font-weight:300;opacity:.75">${k}</div><div style="margin-top:6px;font-size:27px;font-weight:500">${v}</div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <img class="abs" src="${c.name}.jpg" style="left:64px;top:120px;width:952px;height:476px;object-fit:cover">
  <div class="abs" style="left:64px;top:640px">
    <div style="font-size:56px;font-weight:500;letter-spacing:-.02em">${title}</div>
    <div style="margin-top:8px;font-size:25px;font-weight:400;opacity:.85">${source.ko} ${c.ko}</div>
  </div>
  <div class="abs" style="left:64px;right:64px;top:800px;display:grid;grid-template-columns:1fr 1fr;column-gap:48px">${rows}</div>
  <div class="abs" style="left:64px;bottom:60px;font-size:24px;line-height:1.5"><span style="font-weight:300;opacity:.8">제품 문의</span><br><span style="font-weight:600">bathtileco.com</span></div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Material board: the tile face standing beside materials cropped from its own room images.
function matSlide() {
  const { label, lines, body, chips } = source.materials;
  const { c, title } = single();
  const chip = (m, i) => `<div style="position:relative"><img src="mat-${i}.jpg" style="display:block;width:252px;height:252px;object-fit:cover">
    <div class="abs" style="left:10px;bottom:10px;background:rgba(29,28,26,.55);padding:4px 10px;border-radius:12px;font-size:16px;font-weight:600">${m.label}</div></div>`;
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <div class="abs" style="left:64px;top:340px"><div style="position:relative;width:400px;height:800px;overflow:hidden"><img src="${c.name}.jpg" style="position:absolute;left:-200px;top:200px;width:800px;height:400px;transform:rotate(90deg)"></div>
    <div style="margin-top:12px;font-size:19px;font-weight:600">${title}<span style="margin-left:8px;font-weight:400;opacity:.8">${c.size}</span></div></div>
  <div class="abs" style="left:488px;top:340px;display:grid;grid-template-columns:252px 252px;gap:24px">${chips.map(chip).join('')}</div>
  <div class="abs" style="left:488px;right:64px;top:1180px;font-size:20px;line-height:1.55;opacity:.85">${body}</div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

// Three tall views side by side: wall, floor and the real tile.
function stripsSlide() {
  const { label, lines, steps } = source.strips;
  const w = 296;
  const h = 800;
  const cells = steps.map((s, i) => `<div><img src="strip-${i}.jpg" style="display:block;width:${w}px;height:${h}px;object-fit:cover">
    <div style="margin-top:14px;display:flex;gap:10px;align-items:baseline"><span class="en" style="font-size:15px;font-weight:600;opacity:.6">0${i + 1}</span><span style="font-size:20px;font-weight:500">${s}</span></div></div>`).join('');
  return page(`${edHeader(PAPER)}
  <div class="abs" style="left:64px;right:64px;top:112px">${edLabel(label, source.accent.onDark)}${edHeadline(lines, source.accent.onDark)}</div>
  <div class="abs" style="left:64px;top:340px;display:flex;gap:32px">${cells}</div>
  ${logo('logo-white.png')}`, DARK, PAPER);
}

const TEMPLATES = {
  singleStrips: () => [s2CoverSlide(), stripsSlide(), s2FullSlide(), sgSpecSlide()],
  singleMaterial: () => [s2CoverSlide(), matSlide(), s2FullSlide(), s2SpecSlide()],
  singleZoom: () => [s2CoverSlide(), s2ZoomSlide(), s2FullSlide(), s2SpecSlide()],
  single: () => [sgCoverSlide(), sgDetailSlide(), sgFacesSlide(), sgSpaceSlide(), sgSpecSlide()],
  mood: () => source.mood.map((_, i) => moodSlide(i)),
  collectionEditorial: () => [kzCoverSlide(), kzDetailSlide(), kzScenesSlide(), kzSizesSlide(), kzSpecSlide()],
  editorialTone: () => [edCoverSlide(), edToneSlide(), edSpaceZoomSlide(), edSpecSlide()],
  editorialPrints: () => [edCoverSlide(), edPrintsSlide(), edSpaceSlide(), edSpecSlide()],
  editorial: () => [edCoverSlide(), edSurfaceSlide(), edSpaceSlide(), edSpecSlide()],
  series: () => [sceneCoverSlide(), printsMoldsSlide(), surfaceSlide(), specSlide()],
  sizes: () => [moldCoverSlide(), moldConceptSlide(), surfaceBandsSlide(), sizesSlide(), sizesSpecSlide()],
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
