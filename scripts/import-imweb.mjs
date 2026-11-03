import fs from 'node:fs';
import ExcelJS from 'exceljs';
const [fullPath, editPath] = process.argv.slice(2);
const text = (v) => (v && typeof v === 'object' ? v.text ?? v.result ?? v.hyperlink ?? '' : v ?? '');
const strip = (h) => String(text(h)).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function rows(path, headerRow, firstData) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  const headers = {};
  ws.getRow(headerRow).eachCell((c, n) => { headers[n] = String(text(c.value)); });
  const out = [];
  ws.eachRow((row, i) => {
    if (i < firstData) return;
    const o = {};
    row.eachCell((c, n) => { o[headers[n]] = text(c.value); });
    if (/^\d+$/.test(String(o['상품번호']))) out.push(o);
  });
  return out;
}
const full = await rows(fullPath, 1, 2);
const edit = await rows(editPath, 1, 4);
const summary = new Map(edit.map((r) => [String(r['상품번호']), strip(r['요약설명'])]));
const products = full.map((r) => {
  const url = String(text(r['상품URL']));
  const thumb = String(text(r['대표이미지URL']));
  return {
    id: Number(r['상품번호']), name: String(r['상품명']).trim(), category: String(r['카테고리ID'] ?? ''),
    status: r['판매상태'], display: r['진열상태'], origin: r['원산지'] ?? '', brand: r['브랜드'] ?? '',
    url, slug: (url.match(/bathtileco\.com\/([^/?]+)/) || [])[1] ?? '',
    thumb, thumbDate: (thumb.match(/thumbnail\/(\d{8})/) || [])[1] ?? '',
    summary: summary.get(String(r['상품번호'])) ?? '',
  };
}).sort((a, b) => b.id - a.id);
fs.writeFileSync('data/products.json', JSON.stringify(products, null, 2));
const by = (k) => Object.entries(products.reduce((m, p) => ((m[p[k]] = (m[p[k]] || 0) + 1), m), {}));
console.log('total', products.length, 'idRange', products.at(-1).id, products[0].id);
console.log('slug', by('slug').map(([k, v]) => `${k}:${v}`).join(' | '));
console.log('status', by('status').map(([k, v]) => `${k}:${v}`).join(' | '), 'display', by('display').map(([k, v]) => `${k}:${v}`).join(' | '));
const main = products.filter((p) => /600x600|600x1200/i.test(p.slug) || /600\s*[xX]\s*(600|1200)/.test(p.summary));
console.log('main', main.length);
for (const p of main) console.log([p.id, p.thumbDate, p.slug.replace('BT-porcelain',''), p.status, p.display, p.name].join(' ; '));
console.log('sample summary:', main[0]?.summary);
