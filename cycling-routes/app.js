// Club Routes: overlays every route in data/routes.json on a Leaflet map.
// With an upload service configured (config.js), dropped GPX files are sent to it,
// committed to the repository and appear for everyone after the automatic rebuild.
// Without one, dropped files are kept in the visitor's own browser only.
(() => {
  const CFG = window.CLUB_ROUTES_CONFIG || {};
  const UPLOAD_URL = (CFG.uploadUrl || '').replace(/\/$/, '');
  const SHARED = !!UPLOAD_URL;
  const LOCAL_KEY = 'clubroutes.local.v1';
  const PENDING_KEY = 'clubroutes.pending.v1';
  const CRED_KEY = 'clubroutes.uploader.v1';
  const BATCH_FILES = 10, BATCH_BYTES = 8 * 1024 * 1024;
  const POLL_MS = 20000, POLL_FOR_MS = 15 * 60 * 1000;

  const OVERLAP = { color: '#1f4e8c', weight: 3, opacity: 0.35 };
  const SELECTED = { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d6402b', weight: 5, opacity: 1 };

  const $ = s => document.querySelector(s);
  const list = $('#list'), summary = $('#summary'), search = $('#search'), statusEl = $('#status');
  const sortSel = $('#sort'), modeSel = $('#colour-mode'), clearBtn = $('#clear-local'), forgetBtn = $('#forget-code');

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };

  // ---------- map ----------
  const map = L.map('map', { preferCanvas: true }).setView([55.68, 12.57], 9);
  const renderer = L.canvas({ tolerance: 6 });
  const bases = {
    'Light': L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }),
    'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    'CyclOSM': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 20, attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    })
  };
  bases['Light'].addTo(map);
  L.control.layers(bases, null, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // ---------- state ----------
  // r.kind: 'shared' (in data/routes.json), 'pending' (uploaded, waiting for rebuild), 'local' (this browser only)
  let routes = [];
  let selectedId = null;
  let colourIndex = 0;

  const hue = i => `hsl(${(i * 137.508) % 360} 70% 45%)`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function styleFor(r) {
    if (r.id === selectedId) return SELECTED;
    if (r.kind === 'pending') return { color: SELECTED.color, weight: 3, opacity: 0.8, dashArray: '6 6' };
    if (modeSel.value === 'distinct') return { color: r.colour, weight: 3, opacity: 0.85 };
    return OVERLAP;
  }

  function matches(r) {
    const q = search.value.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q);
  }

  function addRoute(r) {
    r.visible = r.visible !== false;
    r.colour = hue(colourIndex++);
    r.layer = L.polyline(r.lines, { renderer, ...styleFor(r) });
    r.layer.on('click', e => { L.DomEvent.stopPropagation(e); select(r.id, false); popup(r, e.latlng); });
    r.layer.on('mouseover', () => { if (r.id !== selectedId) r.layer.setStyle({ weight: 5, opacity: 0.9 }); });
    r.layer.on('mouseout', () => r.layer.setStyle(styleFor(r)));
    routes.push(r);
  }

  function removeRoute(r) {
    r.layer.remove();
    routes = routes.filter(x => x !== r);
  }

  function popup(r, latlng) {
    const extra = {
      shared: `<a href="${esc(r.file)}" download>Download GPX</a>`,
      pending: '<i>Uploaded. Appears for everyone in a minute or two.</i>',
      local: '<i>Uploaded in this browser only</i>'
    }[r.kind];
    L.popup().setLatLng(latlng)
      .setContent(`<b>${esc(r.name)}</b>${r.km} km · ${r.gain} m climbing<br>${extra}`)
      .openOn(map);
  }

  function refreshMap() {
    for (const r of routes) {
      const show = r.visible && matches(r);
      if (show && !map.hasLayer(r.layer)) r.layer.addTo(map);
      if (!show && map.hasLayer(r.layer)) r.layer.remove();
      r.layer.setStyle(styleFor(r));
    }
    const sel = routes.find(r => r.id === selectedId);
    if (sel && map.hasLayer(sel.layer)) sel.layer.bringToFront();
  }

  function renderList() {
    const key = sortSel.value;
    const shown = routes.filter(matches).sort((a, b) =>
      key === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true }) : b[key] - a[key]);
    list.innerHTML = '';
    const tag = { pending: '<span class="tag">processing</span>', local: '<span class="tag">this browser</span>', shared: '' };
    for (const r of shown) {
      const li = document.createElement('li');
      li.dataset.id = r.id;
      if (r.id === selectedId) li.className = 'active';
      const swatch = modeSel.value === 'distinct' && r.kind === 'shared'
        ? `<span class="swatch" style="background:${r.colour}"></span>` : '';
      li.innerHTML = `
        <input type="checkbox" ${r.visible ? 'checked' : ''} aria-label="Show on map">
        <span class="name">${swatch}${esc(r.name)}</span>
        <span class="meta">${tag[r.kind]}${r.km} km · ${r.gain} m</span>`;
      li.querySelector('input').addEventListener('click', e => {
        e.stopPropagation();
        r.visible = e.target.checked;
        refreshMap();
      });
      li.addEventListener('click', () => select(r.id, true));
      list.appendChild(li);
    }
    const total = routes.reduce((s, r) => s + r.km, 0);
    const n = k => routes.filter(r => r.kind === k).length;
    summary.textContent = `${routes.length} routes · ${Math.round(total).toLocaleString()} km in total` +
      (n('pending') ? ` · ${n('pending')} processing` : '') +
      (n('local') ? ` · ${n('local')} only in this browser` : '') +
      (shown.length !== routes.length ? ` · ${shown.length} match` : '');
    clearBtn.hidden = !n('local');
    forgetBtn.hidden = !(SHARED && store.get(CRED_KEY, null));
  }

  function select(id, zoom) {
    selectedId = selectedId === id && zoom ? null : id;
    const r = routes.find(x => x.id === id);
    if (r && selectedId) {
      r.visible = true;
      if (zoom) map.fitBounds(r.layer.getBounds(), { padding: [30, 30] });
    }
    refreshMap();
    renderList();
    const li = list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ block: 'nearest' });
  }

  function fitTo(rs) {
    const layers = rs.filter(r => map.hasLayer(r.layer)).map(r => r.layer);
    if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [20, 20] });
  }

  function setStatus(text, kind = '') {
    statusEl.hidden = !text;
    statusEl.className = kind;
    statusEl.textContent = text || '';
  }

  // ---------- GPX parsing in the browser (mirrors scripts/build.mjs) ----------
  const R = 6371000, rad = d => d * Math.PI / 180;
  const haversine = (a, b) => {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
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
        let t = len2 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function parseGpxText(text, filename) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('not valid XML');
    const segEls = [...doc.getElementsByTagName('trkseg'), ...doc.getElementsByTagName('rte')];
    const segments = segEls.map(seg => [...seg.children]
      .filter(p => p.localName === 'trkpt' || p.localName === 'rtept')
      .map(p => {
        const e = p.getElementsByTagName('ele')[0];
        return [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon')), e ? parseFloat(e.textContent) : NaN];
      })
      .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])))
      .filter(s => s.length > 1);
    if (!segments.length) throw new Error('no track points');
    let dist = 0, gain = 0;
    for (const seg of segments) {
      let last = null;
      seg.forEach((p, i) => {
        if (i) dist += haversine(seg[i - 1], p);
        if (Number.isFinite(p[2])) {
          if (last === null) last = p[2];
          else if (p[2] - last > 3) { gain += p[2] - last; last = p[2]; }
          else if (last - p[2] > 3) last = p[2];
        }
      });
    }
    const nameEl = doc.querySelector('trk > name, rte > name, metadata > name');
    return {
      name: (nameEl && nameEl.textContent.trim()) || filename.replace(/\.gpx$/i, ''),
      km: +(dist / 1000).toFixed(1), gain: Math.round(gain),
      lines: segments.map(s => simplify(s, 8).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]))
    };
  }

  // ---------- persistence ----------
  const plain = ({ id, sharedId, name, km, gain, lines, kind, since }) => ({ id, sharedId, name, km, gain, lines, kind, since });
  function saveBrowserRoutes() {
    store.set(PENDING_KEY, routes.filter(r => r.kind === 'pending').map(plain));
    if (!store.set(LOCAL_KEY, routes.filter(r => r.kind === 'local').map(plain)))
      setStatus('Browser storage is full, so these routes disappear when the page closes.', 'error');
  }

  // ---------- reading dropped files ----------
  async function readFiles(files) {
    const ok = [], failed = [];
    for (const f of files) {
      if (!/\.gpx$/i.test(f.name)) { failed.push(`${f.name}: not a .gpx file`); continue; }
      try { ok.push({ file: f, ...parseGpxText(await f.text(), f.name) }); }
      catch (err) { failed.push(`${f.name}: ${err.message}`); }
    }
    return { ok, failed };
  }

  async function handleFiles(files) {
    if (!files.length) return;
    const { ok, failed } = await readFiles(files);
    if (!ok.length) { setStatus('Nothing added. ' + failed.join(' · '), 'error'); return; }
    if (SHARED) return uploadShared(ok, failed);

    // Local-only mode
    for (const p of ok) {
      const id = 'local:' + p.file.name;
      const old = routes.find(r => r.id === id);
      if (old) removeRoute(old);
      addRoute({ id, name: p.name, km: p.km, gain: p.gain, lines: p.lines, kind: 'local' });
    }
    saveBrowserRoutes();
    refreshMap(); renderList();
    fitTo(routes.filter(r => ok.some(p => r.id === 'local:' + p.file.name)));
    setStatus(failed.length ? 'Some files could not be read: ' + failed.join(' · ') : '', failed.length ? 'error' : '');
  }

  // ---------- shared uploads ----------
  const dialog = $('#code-dialog'), codeInput = $('#code-input'), nameInput = $('#name-input'), codeError = $('#code-error');

  function askForCode(errorText, previous) {
    const saved = previous || store.get(CRED_KEY, {}) || {};
    codeInput.value = errorText ? '' : (saved.code || '');
    nameInput.value = saved.name || '';
    codeError.hidden = !errorText;
    codeError.textContent = errorText || '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok' || !codeInput.value.trim()) return resolve(null);
        const cred = { code: codeInput.value.trim(), name: nameInput.value.trim() };
        resolve(cred);
      }, { once: true });
      dialog.showModal();
      (codeInput.value ? nameInput : codeInput).focus();
    });
  }

  function batches(items) {
    const out = [];
    let cur = [], bytes = 0;
    for (const it of items) {
      if (cur.length && (cur.length >= BATCH_FILES || bytes + it.file.size > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
      cur.push(it); bytes += it.file.size;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  async function postBatch(batch, cred) {
    const fd = new FormData();
    fd.append('code', cred.code);
    if (cred.name) fd.append('uploader', cred.name);
    batch.forEach(it => fd.append('files', it.file, it.file.name));
    let res;
    try { res = await fetch(UPLOAD_URL + '/upload', { method: 'POST', body: fd }); }
    catch { throw Object.assign(new Error('Could not reach the upload service. Check your connection and try again.'), { status: 0 }); }
    let body = {};
    try { body = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(body.error || `Upload failed (${res.status})`), { status: res.status });
    return body;
  }

  let uploading = false;
  async function uploadShared(parsed, readFailures) {
    if (uploading) { setStatus('An upload is already running. Wait for it to finish.', 'error'); return; }
    let cred = store.get(CRED_KEY, null);
    if (!cred || !cred.code) cred = await askForCode();
    if (!cred) { setStatus(''); return; }

    uploading = true;
    const added = [], skipped = [...readFailures];
    let dupes = 0;
    const queue = batches(parsed);
    try {
      for (let i = 0; i < queue.length; i++) {
        const batch = queue[i];
        setStatus(`Uploading ${added.length + 1}–${Math.min(added.length + batch.length, parsed.length)} of ${parsed.length}…`);
        let result;
        try { result = await postBatch(batch, cred); }
        catch (err) {
          if (err.status === 401) {
            store.del(CRED_KEY);
            cred = await askForCode('That club code was not accepted. Try again.', cred);
            if (!cred) throw new Error('Upload cancelled.');
            i--; continue;
          }
          throw err;
        }
        store.set(CRED_KEY, cred);
        for (const a of result.added || []) {
          const p = batch.find(it => it.file.name === a.file);
          if (!p) continue;
          addRoute({ id: 'pending:' + a.id, sharedId: a.id, name: p.name, km: p.km, gain: p.gain, lines: p.lines, kind: 'pending', since: Date.now() });
          added.push(a);
        }
        for (const s of result.skipped || []) {
          if (/^already on the map/.test(s.reason)) dupes++;
          else skipped.push(`${s.file}: ${s.reason}`);
        }
      }
      const msg = added.length
        ? `Added ${added.length} route${added.length > 1 ? 's' : ''}. ${added.length > 1 ? 'They appear' : 'It appears'} for everyone in a minute or two.`
        : 'No new routes added.';
      const dupeText = dupes ? ` ${dupes} ${dupes > 1 ? 'were' : 'was'} already on the map.` : '';
      setStatus(msg + dupeText + (skipped.length ? ' Skipped: ' + skipped.join(' · ') : ''), skipped.length && !added.length ? 'error' : 'ok');
    } catch (err) {
      setStatus((added.length ? `Added ${added.length}, then stopped. ` : '') + err.message, 'error');
    } finally {
      uploading = false;
      saveBrowserRoutes();
      refreshMap(); renderList();
      fitTo(routes.filter(r => added.some(a => r.sharedId === a.id)));
      if (added.length) startPolling();
    }
  }

  // ---------- loading shared data, and swapping pending routes in ----------
  async function fetchShared() {
    const res = await fetch('data/routes.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    return (await res.json()).routes || [];
  }

  function mergeShared(shared) {
    const have = new Set(routes.filter(r => r.kind === 'shared').map(r => r.id));
    const arrived = [];
    for (const s of shared) {
      if (have.has(s.id)) continue;
      const pending = routes.find(r => r.kind === 'pending' && r.sharedId === s.id);
      if (pending) {
        const wasSelected = selectedId === pending.id;
        removeRoute(pending);
        if (wasSelected) selectedId = s.id;
      }
      addRoute({ ...s, kind: 'shared' });
      arrived.push(s.id);
    }
    return arrived;
  }

  let pollTimer = null, pollUntil = 0;
  function startPolling() {
    pollUntil = Date.now() + POLL_FOR_MS;
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!routes.some(r => r.kind === 'pending') || Date.now() > pollUntil) {
        clearInterval(pollTimer); pollTimer = null; return;
      }
      try {
        const arrived = mergeShared(await fetchShared());
        if (arrived.length) {
          saveBrowserRoutes(); refreshMap(); renderList();
          if (!routes.some(r => r.kind === 'pending')) setStatus('All uploaded routes are now on the shared map.', 'ok');
        }
      } catch { /* try again next tick */ }
    }, POLL_MS);
  }

  // ---------- events ----------
  const drop = $('#drop'), fileInput = $('#file-input');
  $('#drop-hint').textContent = SHARED
    ? 'Drop files here or click to choose. They are added to the club map for everyone.'
    : 'Drop files here or click to choose. Kept in this browser only.';
  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
  document.addEventListener('drop', e => handleFiles([...e.dataTransfer.files]));

  search.addEventListener('input', () => { refreshMap(); renderList(); });
  sortSel.addEventListener('change', renderList);
  modeSel.addEventListener('change', () => { refreshMap(); renderList(); });
  $('#all-on').addEventListener('click', () => { routes.filter(matches).forEach(r => r.visible = true); refreshMap(); renderList(); });
  $('#all-off').addEventListener('click', () => { routes.filter(matches).forEach(r => r.visible = false); refreshMap(); renderList(); });
  $('#fit').addEventListener('click', () => fitTo(routes));
  clearBtn.addEventListener('click', () => {
    routes.filter(r => r.kind === 'local').forEach(removeRoute);
    saveBrowserRoutes(); renderList();
  });
  forgetBtn.addEventListener('click', () => { store.del(CRED_KEY); renderList(); setStatus('Club code forgotten on this device.'); });
  map.on('click', () => { if (selectedId) { selectedId = null; refreshMap(); renderList(); } });

  // ---------- boot ----------
  (async () => {
    let shared = [];
    try { shared = await fetchShared(); } catch { /* opened from disk or not built yet */ }
    shared.forEach(s => addRoute({ ...s, kind: 'shared' }));
    const sharedIds = new Set(shared.map(s => s.id));
    const stillPending = store.get(PENDING_KEY, []).filter(p => !sharedIds.has(p.sharedId) && Date.now() - (p.since || 0) < 24 * 3600e3);
    stillPending.forEach(addRoute);
    store.get(LOCAL_KEY, []).forEach(p => addRoute({ ...p, kind: 'local' }));
    saveBrowserRoutes();
    refreshMap(); renderList();
    if (routes.length) fitTo(routes);
    else summary.textContent = 'No routes yet. Drop GPX files above to add the first one.';
    if (stillPending.length) startPolling();
  })();
})();
