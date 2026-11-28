// Service worker for whatsacross.com (same pattern as orrery.live / quickresponse.now).
//
//  - Code and navigations: NETWORK-FIRST, cache fallback. three.js is precached here and the 3.7 MB
//    country dataset in ASSETS, so the whole globe works offline once loaded.
//  - The big files in /data/ (the country dataset and the map-layer pyramids, fetch()ed from JS):
//    CACHE-FIRST from ASSETS, which a deploy keeps (see below). The pyramids are fetched only when
//    a layer needs them.
//  - Other images: CACHE-FIRST.
//  - Bump CACHE on deploys that change any precached file, the /data/ ones included.
const CACHE = 'wa-v13';
// "/" and folder URLs only, never ".../index.html": since 2026-11-27 those 301 to their folder, and a cached
// redirect cannot be served for a navigation (Chromium refuses it), which would break the offline fallback.
const CORE = [
	'/',
	'/across/',
	'/guide.css',
	'/styles.css',
	'/app.js',
	'/lib/three.module.js',
	'/lib/three.core.js',
	'/lib/topojson-client.min.js',
	'/favicon.svg',
	'/manifest.json'
];

// ---- The big files, kept across deploys (2026-11-28; the fleet block, as in lookupanddown.com,
// orrery.live, talkinghurts.com and c2paview.com) -------------------------------------------------
// They used to sit in CACHE, so every deploy threw them away and a returning visitor downloaded them
// again. They now live in ASSETS, which a deploy keeps. Each update (install) asks the server whether
// each kept file has changed, with a HEAD request (headers only, no body), and compares ETags
// (CloudFront marks a compressed copy's ETag weak, W/"…", so the W/ is ignored). An unchanged file is
// kept; a changed one is fetched again (a precached one at once, any other when next needed). So a
// file changed in place needs only the usual CACHE bump, which is what makes the update run. The new
// copies go into STAGE and are swapped in on activate, never while the old worker may still be
// serving from ASSETS.
const ASSETS = 'wa-assets';
const STAGE = 'wa-assets-next';
const ASSET_CORE = ['/data/countries-10m.json'];
const isAsset = (url) => /^\/data\/[^/]+\.(jpg|json)$/.test(new URL(url, location.href).pathname);
const etagOf = (res) => ((res && res.headers.get('ETag')) || '').replace(/^W\//, '');
const GONE = 'X-Asset-Gone';   // a STAGE entry carrying this header means "delete it from ASSETS"

async function stageAssets() {
	await caches.delete(STAGE);   // what a half-finished earlier install left
	const assets = await caches.open(ASSETS), stage = await caches.open(STAGE);
	// What this browser holds: ASSETS, then any big file an older worker kept in its own cache.
	const held = new Map();
	for (const r of await assets.keys()) held.set(new URL(r.url).pathname, { c: assets, r, kept: true });
	for (const k of await caches.keys()) {
		if (k === ASSETS || k === STAGE || k === CACHE) continue;
		const c = await caches.open(k);
		for (const r of await c.keys()) {
			const p = new URL(r.url).pathname;
			if (isAsset(r.url) && !held.has(p)) held.set(p, { c, r, kept: false });
		}
	}
	await Promise.all([...new Set([...held.keys(), ...ASSET_CORE])].map(async (p) => {
		const h = held.get(p), copy = h && await h.c.match(h.r);
		let same = false;
		if (copy && etagOf(copy)) {
			try {
				const head = await fetch(p, { method: 'HEAD', cache: 'no-store' });
				same = head.ok && etagOf(head) === etagOf(copy);
			} catch (err) { same = true; }   // no answer: keep what is here
		}
		if (same) { if (!h.kept) await stage.put(p, copy); return; }   // an older cache's copy moves across
		// Changed, gone from the server, or never fetched. A precached file is fetched now (a failure fails
		// the install, as addAll always did); any other kept one is dropped, to be fetched when next needed.
		if (ASSET_CORE.includes(p)) await stage.add(new Request(p, { cache: 'no-cache' }));
		else if (h && h.kept) await stage.put(p, new Response(null, { headers: { [GONE]: '1' } }));
	}));
}

async function applyAssets() {
	if (!(await caches.has(STAGE))) return;
	const stage = await caches.open(STAGE), assets = await caches.open(ASSETS);
	for (const r of await stage.keys()) {
		const res = await stage.match(r);
		if (res.headers.get(GONE)) await assets.delete(r);
		else await assets.put(r, res);
	}
	await caches.delete(STAGE);
}

async function fromAssets(e, req) {
	const c = await caches.open(ASSETS);
	const hit = await c.match(req);
	if (hit) return hit;
	const res = await fetch(req);
	// waitUntil: without it the worker can be killed before the write lands, which made offline
	// caching of the big map layers unreliable.
	if (res.ok) e.waitUntil(c.put(req, res.clone()).catch(() => { /* storage full: carry on */ }));
	return res;
}
// ---- end of the fleet block ----

self.addEventListener('install', (e) => {
	e.waitUntil(Promise.all([caches.open(CACHE).then((c) => c.addAll(CORE)), stageAssets()]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		applyAssets()
			.then(() => caches.keys())
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== ASSETS).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

	if (isAsset(req.url)) { e.respondWith(fromAssets(e, req)); return; }

	if (req.destination === 'image') {
		e.respondWith(
			caches.open(CACHE).then(async (c) => {
				const hit = await c.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				// waitUntil, so the worker isn't stopped before the write lands.
				if (res.ok) e.waitUntil(c.put(req, res.clone()));
				return res;
			})
		);
		return;
	}

	e.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
				return res;
			})
			.catch(async () => {
				const hit = await caches.match(req);
				if (hit) return hit;
				if (req.mode === 'navigate') { const shell = await caches.match('/'); if (shell) return shell; }
				return Response.error();
			})
	);
});
