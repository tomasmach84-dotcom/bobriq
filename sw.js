/* ════════════════════════════════════════════════════════════════════
   BOBRIQ — offline vrstva (service worker).  ŠABLONA, ze které build
   (make-pwa.mjs / make-pwa-lock.mjs) generuje ../BOBRIQ-PWA/sw.js.
   Ručně needitovat vygenerovaný sw.js, uprav tuhle šablonu a přebuilduj.

   Build doplní tři hodnoty:
     CACHE     název mezipaměti s otiskem obsahu (změna appky = nová verze)
     ASSETS    soubory, které build SKUTEČNĚ vytvořil
     CRITICAL  ty, bez kterých nemá offline režim smysl
   ════════════════════════════════════════════════════════════════════ */
const CACHE = 'bobriq-a4102adad6e5';
const ASSETS = ["./","./index.html","./manifest.webmanifest","./app.enc.bin","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-512-maskable.png","./icons/apple-touch-icon.png"];
const CRITICAL = ["./","./index.html"];
const INDEX = './index.html';
const PREFIX = 'bobriq-';          // mažeme jen svoje mezipaměti, cizí necháme být

// Absolutní adresy precachovaných souborů (bez ?v=…), ať je jedno,
// s jakým cache-busting parametrem si je stránka vyžádá.
const ASSET_URLS = new Set(ASSETS.map(function (a) { return stripQuery(new URL(a, self.location).href); }));

function stripQuery(href) {
  const u = new URL(href);
  u.search = ''; u.hash = '';
  return u.href;
}
// Klíč do mezipaměti: u známých assetů bez parametrů (jinak by cache bobtnala
// duplicitami icon.png, icon.png?v=4, icon.png?v=5…), u ostatních tak, jak přišly.
function keyFor(request) {
  const bare = stripQuery(request.url);
  return ASSET_URLS.has(bare) ? bare : request.url;
}
function isCacheable(res) {
  return !!res && res.ok && (res.type === 'basic' || res.type === 'default' || res.type === undefined);
}

/* ── INSTALACE ────────────────────────────────────────────────────────
   Soubory se stahují po jednom. Když vypadne něco nepovinného (ikona),
   instalace pokračuje — appka bude offline fungovat i tak. Když chybí
   něco kritického, instalace SELŽE a rozdělaná mezipaměť se uklidí:
   starý service worker i jeho mezipaměť zůstávají netknuté a funkční. */
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    const failed = [];
    await Promise.all(ASSETS.map(async function (url) {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
        await cache.put(stripQuery(new URL(url, self.location).href), res.clone());
      } catch (e) {
        failed.push(url);
      }
    }));
    const chybiKriticke = CRITICAL.filter(function (u) { return failed.indexOf(u) >= 0; });
    if (chybiKriticke.length) {
      await caches.delete(CACHE);   // po nepovedené instalaci nezůstane poloprázdná mezipaměť
      throw new Error('BOBRIQ: offline verzi se nepodařilo připravit, chybí ' + chybiKriticke.join(', '));
    }
    // skipWaiting se ZÁMĚRNĚ nevolá: nová verze počká, dokud si o ni stránka neřekne
    // (zpráva SKIP_WAITING), ať se otevřeným záložkám nepřepne appka pod rukama.
  })());
});

/* ── AKTIVACE ─────────────────────────────────────────────────────────
   Staré mezipaměti mažeme, až když je ta nová prokazatelně použitelná. */
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    const hotovo = await cache.match(stripQuery(new URL(INDEX, self.location).href));
    if (hotovo) {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter(function (k) { return k !== CACHE && k.indexOf(PREFIX) === 0; })
        .map(function (k) { return caches.delete(k); }));
    }
    await self.clients.claim();
  })());
});

// Stránka si řekne, kdy je bezpečné se přepnout na novou verzi.
self.addEventListener('message', function (event) {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'VERSION' && event.ports && event.ports[0]) event.ports[0].postMessage(CACHE);
});

/* ── SÍŤ ──────────────────────────────────────────────────────────────
   Appka (index.html a soubory ze seznamu precache) se podává z mezipaměti
   a BĚHEM BĚHU se nepřepisuje. Je to schválně: u zamčené verze musí
   index.html (nese sůl k rozšifrování) a app.enc.bin pocházet z jednoho
   sestavení. Kdyby se každý bral odjinud, appka by po nasazení nové verze
   hlásila špatné heslo. Nová verze se proto nasazuje celá naráz — přes
   instalaci nového service workeru, viz výš.

   Ostatní požadavky: nejdřív internet, offline poslední uložená odpověď.
   Do mezipaměti jde jen úspěšná odpověď — 404 ani 500 se neukládá.
   index.html se vrací JEN u navigace; chybějící obrázek dostane 504,
   ne kus HTML, který by se stejně nedal zobrazit. */
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;      // cizí adresy neřešíme
  if (req.mode === 'navigate' || jeSoucastAppky(req)) { event.respondWith(handleAppShell(req)); return; }
  event.respondWith(handleRuntime(event));
});

function jeSoucastAppky(request) { return ASSET_URLS.has(stripQuery(request.url)); }

async function fromCache(request) {
  const presne = await caches.match(keyFor(request));
  if (presne) return presne;
  return caches.match(request, { ignoreSearch: true });
}
async function fetchAndCache(request) {
  const res = await fetch(request);
  if (isCacheable(res)) {
    const cache = await caches.open(CACHE);
    await cache.put(keyFor(request), res.clone());
  }
  return res;
}

/* Appka: z mezipaměti (celá verze pohromadě). Co v mezipaměti není,
   se zkusí stáhnout; teprve když ani to nejde a jde o navigaci, podá se
   uložený index.html. */
async function handleAppShell(request) {
  const ulozena = await fromCache(request);
  if (ulozena) return ulozena;
  try {
    const res = await fetchAndCache(request);
    if (res) return res;
  } catch (e) { /* offline */ }
  if (request.mode !== 'navigate') return new Response('', { status: 504, statusText: 'Offline a soubor není v mezipaměti' });
  const index = await caches.match(stripQuery(new URL(INDEX, self.location).href));
  if (index) return index;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>BOBRIQ</title>'
    + '<body style="font-family:system-ui,sans-serif;padding:24px;line-height:1.5">'
    + '<h1>BOBRIQ se teď nenačetl</h1><p>Vypadá to na výpadek připojení a offline verzi ještě nemám uloženou. '
    + 'Zkus to prosím znovu, až budeš online.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* Ostatní požadavky (nic z appky): nejdřív internet, offline poslední
   uložená odpověď. Chybějící soubor dostane 504, nikdy ne index.html. */
async function handleRuntime(event) {
  const request = event.request;
  try {
    const res = await fetchAndCache(request);
    if (res) return res;             // i chybová odpověď se vrátí tak, jak přišla (jen se neuloží)
  } catch (e) { /* offline */ }
  const ulozena = await fromCache(request);
  if (ulozena) return ulozena;
  return new Response('', { status: 504, statusText: 'Offline a soubor není v mezipaměti' });
}
