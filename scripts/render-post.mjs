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
if (source.space) await cropRegion(path.join(source.sourceDir, source.space.file), 'space.jpg', source.space.crop, W, 620);
if (source.scene) await coverCrop(path.join(source.sourceDir, source.scene), 'scene.jpg');
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
    <span style="width:28px;height:2px;background:currentColor"></span>${source.collection} ${colors[0].name}</div>`;
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

const TEMPLATES = {
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
