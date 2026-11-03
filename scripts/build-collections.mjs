// Groups 600x600 / 600x1200 products into collections, newest first (by Imweb product id).
import fs from 'node:fs';
const RULES = [
  ['ARENITE STRIPE', /-STRIPE/], ['ARENITE', /\bARE \d/], ['FORTE', /\bFOR \d/], ['ICONA', /ICONA/], ['STARS', /STARS/],
  ['KENZO', /KENZO/], ['NEWTON', /NEWTON/], ['PEBBLE', /PEBBLE/], ['SANTA MONICA', /SANTA MONICA/], ['VISTA ROCK', /VISTA/],
  ['JASMINE', /JASMINE/], ['DREAMY', /DREAMY/], ['CAMELLIA', /CAMELLIA/], ['Q-STONE', /Q-STONE/], ['VANTAGE', /VANTAGE/],
  ['ALPHA', /ALPHA/], ['CLOUD', /CLOUD/], ['META STONE', /META STONE/], ['MARBLE', /WINSLOW|ALBA|CANYON|LA PLATA|PIETRA MIX|AZUL|MANDALA|NILE|MYSTERIOUS/],
  ['PEACE', /PEACE/], ['TRAVERTINO', /TRAVERTINO/], ['EDGE LEON', /EDGE-LEON/], ['EDGE LATINA', /EDGE-LATINA/], ['EDGE PISA', /EDGE-PISA/],
  ['EDGE REUS', /EDGE-REUS/], ['BT-MD', /BT-MD/], ['DOMINANT', /BT-DN/], ['MODERN CONCRETE', /MODERN CONCRETE/], ['LIMESTONE 2.0', /LIMESTONE/], ['RIVER ROCK', /RIVER ROCK/],
  ['CRETE', /\bCRETE/], ['SUPREME', /SUPREME/], ['ENZO', /ENZO/], ['CEMENTARO', /CEMENTARO/], ['BALTIMORE', /BALTIMORE/],
  ['OVERLAND', /OVERLAND/], ['TOSCANA', /TOSCANA/],
];
const products = JSON.parse(fs.readFileSync('data/products.json', 'utf8'))
  .filter((p) => /^BT-porcelain600x(600|1200)$/.test(p.slug));
const groups = new Map();
for (const p of products) {
  const name = RULES.find(([, re]) => re.test(p.name))?.[0] ?? `기타: ${p.name}`;
  if (!groups.has(name)) groups.set(name, []);
  groups.get(name).push(p);
}
const collections = [...groups].map(([name, items]) => {
  const inStock = items.filter((p) => p.status === '판매중');
  const sizeOf = (p) => (p.slug.endsWith('1200') ? '600x1200' : '600x600');
  return {
    name, newestId: Math.max(...items.map((p) => p.id)),
    sizes: [...new Set(inStock.map(sizeOf))].sort(), inStock: inStock.length, soldOut: items.length - inStock.length,
    products: inStock.map((p) => ({ id: p.id, name: p.name, size: sizeOf(p), url: p.url, summary: p.summary })),
  };
}).filter((c) => c.inStock > 0).sort((a, b) => b.newestId - a.newestId);
const named = collections.filter((c) => !c.name.startsWith('기타:'));
fs.writeFileSync('data/collections.json', JSON.stringify(named, null, 2));
named.forEach((c, i) => console.log(`${String(i + 1).padStart(2)}. ${c.name}  #${c.newestId}  ${c.sizes.join('+')}  판매중 ${c.inStock}${c.soldOut ? ` (품절 ${c.soldOut} 제외)` : ''}`));
console.log('\n미분류:', collections.filter((c) => c.name.startsWith('기타:')).map((c) => c.name.replace('기타: ', '')).join(', '));
