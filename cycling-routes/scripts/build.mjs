// Converts every .gpx file in /routes into one compact data/routes.json.
// No dependencies: run with `node scripts/build.mjs`.
// Points are simplified (Douglas-Peucker, ~8 m tolerance) so 150+ routes load quickly.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const ROUTES_DIR = 'routes';
const OUT = 'data/routes.json';
const TOLERANCE_M = 8;

const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

function parseGpx(xml) {
  const nameMatch = xml.match(/<(?:trk|rte)>[\s\S]*?<name>([\s\S]*?)<\/name>/) || xml.match(/<metadata>[\s\S]*?<name>([\s\S]*?)<\/name>/);
  const segments = [];
  // Each <trkseg> or <rte> becomes its own line, so gaps aren't joined.
  const blocks = xml.match(/<trkseg[\s\S]*?<\/trkseg>|<rte[\s\S]*?<\/rte>/g) || [xml];
  for (const block of blocks) {
    const pts = [];
    const re = /<(?:trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept)>)/g;
    let m;
    while ((m = re.exec(block))) {
      const lat = parseFloat((m[1].match(/lat\s*=\s*["']([^"']+)/) || [])[1]);
      const lon = parseFloat((m[1].match(/lon\s*=\s*["']([^"']+)/) || [])[1]);
      const ele = m[2] ? parseFloat((m[2].match(/<ele>([^<]+)<\/ele>/) || [])[1]) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon, ele]);
    }
    if (pts.length > 1) segments.push(pts);
  }
  return { name: nameMatch ? decode(nameMatch[1]) : null, segments };
}

const R = 6371000, rad = d => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Douglas-Peucker on a local equirectangular projection (metres).
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const lat0 = rad(pts[0][0]);
  const xy = pts.map(p => [rad(p[1]) * Math.cos(lat0) * R, rad(p[0]) * R]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = xy[s], [bx, by] = xy[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function stats(segments) {
  let dist = 0, gain = 0;
  for (const seg of segments) {
    let lastEle = null;
    for (let i = 0; i < seg.length; i++) {
      if (i) dist += haversine(seg[i - 1], seg[i]);
      const e = seg[i][2];
      if (Number.isFinite(e)) {
        // 3 m threshold filters GPS noise that inflates climbing figures.
        if (lastEle === null) lastEle = e;
        else if (e - lastEle > 3) { gain += e - lastEle; lastEle = e; }
        else if (lastEle - e > 3) lastEle = e;
      }
    }
  }
  return { km: +(dist / 1000).toFixed(1), gain: Math.round(gain) };
}

const files = (await readdir(ROUTES_DIR)).filter(f => f.toLowerCase().endsWith('.gpx')).sort();
const routes = [];
for (const file of files) {
  try {
    const { name, segments } = parseGpx(await readFile(join(ROUTES_DIR, file), 'utf8'));
    if (!segments.length) { console.warn(`skip ${file}: no track points`); continue; }
    const s = stats(segments); // stats on full-resolution data
    const lines = segments.map(seg => simplify(seg, TOLERANCE_M).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]));
    routes.push({ id: file, name: name || basename(file, '.gpx'), file: `${ROUTES_DIR}/${file}`, ...s, lines });
  } catch (err) {
    console.warn(`skip ${file}: ${err.message}`);
  }
}
await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), routes }));
console.log(`${routes.length} routes -> ${OUT}`);
