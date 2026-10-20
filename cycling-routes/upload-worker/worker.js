// Club Routes upload service: a Cloudflare Worker that receives GPX files from the
// map page and commits them to the repository's routes/ folder. The commit triggers
// the GitHub Action, which rebuilds the shared map.
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   GITHUB_TOKEN    secret  fine-grained token, Contents: read and write, this repo only
//   UPLOAD_CODE     secret  the club code members type on the page
//   GITHUB_REPO     text    e.g. "my-club/club-routes"
//   GITHUB_BRANCH   text    optional, default "main"
//   ALLOWED_ORIGIN  text    the site's origin, e.g. "https://my-club.github.io"
//   GITHUB_API      text    optional, only for testing against a mock API

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 25;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === 'GET') return json({ ok: true, service: 'club-routes-upload' });
    if (request.method !== 'POST' || !['/upload', '/check'].includes(url.pathname)) return json({ error: 'Not found' }, 404);

    for (const key of ['GITHUB_TOKEN', 'UPLOAD_CODE', 'GITHUB_REPO']) {
      if (!env[key]) return json({ error: `Upload service is missing the ${key} setting` }, 500);
    }

    let form;
    try { form = await request.formData(); } catch { return json({ error: 'Expected a file upload' }, 400); }

    if (!safeEqual(String(form.get('code') || '').trim(), String(env.UPLOAD_CODE).trim())) {
      await new Promise(r => setTimeout(r, 800)); // slows down guessing
      return json({ error: 'Wrong club code' }, 401);
    }
    if (url.pathname === '/check') return json({ ok: true });

    const uploader = String(form.get('uploader') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    const files = form.getAll('files').filter(f => typeof f === 'object' && f && 'name' in f);
    if (!files.length) return json({ error: 'No files received' }, 400);
    if (files.length > MAX_FILES) return json({ error: `Send at most ${MAX_FILES} files per request` }, 400);

    const skipped = [], accepted = [];
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) { skipped.push({ file: f.name, reason: 'larger than 15 MB' }); continue; }
      const text = await f.text();
      const problem = checkGpx(text);
      if (problem) { skipped.push({ file: f.name, reason: problem }); continue; }
      accepted.push({ original: f.name, text, sha: await gitBlobSha(text) });
    }
    if (!accepted.length) return json({ added: [], skipped });

    const gh = github(env);
    // Retry when someone else committed at the same moment.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await commitFiles(gh, env, accepted, uploader);
        return json({ added: result.added, skipped: [...skipped, ...result.skipped], commit: result.commit });
      } catch (err) {
        if (err.status === 422 && attempt < 3) continue;
        return json({ error: `Could not save to GitHub: ${err.message}` }, 502);
      }
    }
  }
};

async function commitFiles(gh, env, accepted, uploader) {
  const branch = env.GITHUB_BRANCH || 'main';
  const ref = await gh('GET', `/git/ref/heads/${branch}`);
  const headSha = ref.object.sha;
  const head = await gh('GET', `/git/commits/${headSha}`);
  const root = await gh('GET', `/git/trees/${head.tree.sha}`);
  const routesDir = root.tree.find(e => e.path === 'routes' && e.type === 'tree');
  const existing = routesDir ? (await gh('GET', `/git/trees/${routesDir.sha}`)).tree : [];

  const names = new Set(existing.map(e => e.path.toLowerCase()));
  const shas = new Map(existing.map(e => [e.sha, e.path]));
  const added = [], skipped = [], entries = [];

  for (const f of accepted) {
    if (shas.has(f.sha)) { skipped.push({ file: f.original, reason: `already on the map as ${shas.get(f.sha)}` }); continue; }
    const name = uniqueName(slug(f.original), names);
    names.add(name.toLowerCase());
    shas.set(f.sha, name);
    entries.push({ path: `routes/${name}`, mode: '100644', type: 'blob', content: f.text });
    added.push({ file: f.original, path: `routes/${name}`, id: name });
  }
  if (!entries.length) return { added, skipped, commit: null };

  const tree = await gh('POST', '/git/trees', { base_tree: head.tree.sha, tree: entries });
  const list = added.map(a => `- ${a.id}`).join('\n');
  const message = `Add ${added.length} route${added.length > 1 ? 's' : ''} via upload page` +
    (uploader ? ` (${uploader})` : '') + `\n\n${list}`;
  const commit = await gh('POST', '/git/commits', { message, tree: tree.sha, parents: [headSha] });
  await gh('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
  return { added, skipped, commit: commit.sha };
}

function github(env) {
  const base = `${(env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '')}/repos/${env.GITHUB_REPO}`;
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'club-routes-upload',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try { msg += ' ' + ((await res.json()).message || ''); } catch {}
      const err = new Error(msg.trim()); err.status = res.status; throw err;
    }
    return res.json();
  };
}

function checkGpx(text) {
  if (!/<gpx[\s>]/i.test(text)) return 'not a GPX file';
  const pts = text.match(/<(?:trkpt|rtept)\b[^>]*\blat\s*=/gi);
  if (!pts || pts.length < 2) return 'no track points';
  return null;
}

// Same SHA git uses for a file, so identical uploads are recognised.
async function gitBlobSha(text) {
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header); all.set(body, header.length);
  const hash = await crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function slug(filename) {
  const base = filename.replace(/\.gpx$/i, '').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return (base || 'route') + '.gpx';
}

function uniqueName(name, taken) {
  if (!taken.has(name.toLowerCase())) return name;
  const stem = name.replace(/\.gpx$/, '');
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}.gpx`)) return `${stem}-${i}.gpx`;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
