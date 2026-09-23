/* ════════════════════════════════════════════════════════════════════
   BOBRIQ — offline vrstva (service worker).  ŠABLONA, ze které build
   (make-pwa.mjs / make-pwa-lock.mjs) generuje ../BOBRIQ-PWA/sw.js.
   Ručně needitovat vygenerovaný sw.js, uprav tuhle šablonu a přebuilduj.

   Build doplní tyto hodnoty:
     CACHE           název mezipaměti s otiskem obsahu (změna appky = nová verze)
     ASSETS          soubory, které build SKUTEČNĚ vytvořil
     CRITICAL        ty, bez kterých nemá offline režim smysl
     AKTUALIZACE     odkud a z jakého kanálu se stahují nové verze
     VEREJNE_KLICE   veřejné klíče (s kid) na ověření podpisů
   ════════════════════════════════════════════════════════════════════ */
const CACHE = 'bobriq-90a4d970ea0e';
const ASSETS = ["./","./index.html","./manifest.webmanifest","./app.enc.bin","./icons/icon-192.png","./icons/icon-512.png","./icons/icon-512-maskable.png","./icons/apple-touch-icon.png"];
const CRITICAL = ["./","./index.html"];
const AKTUALIZACE = {"puvod":"https://licence.bobriq.cz","kanal":"stabilni"};
const VEREJNE_KLICE = [{"kid":"lic-2026-08-05-qs3s","ucel":"licence","klic":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEK62FDunGSWIWLd0Npaentm9mselCPs1Uyrkry5sKq7XUR5erd/Kre5RUgrjrsIQN+QlOaer3twkMSm/S6dCjXg=="},{"kid":"vyd-2026-08-05-a2uo","ucel":"vydani","klic":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZ4lSCCUqLTxsoxy0QxDzXCF4mUOZqxTdSAEpm6PSTwMKt1YSJ/w8Xo0iynf7Rk9/u6ArXkHpIfuYuwRcq2zZWw=="}];
const INDEX = './index.html';
const PREFIX = 'bobriq-';          // mažeme jen svoje mezipaměti, cizí necháme být
const ODKLADISTE = CACHE + '-odkladiste';   // sem se stahuje nová verze, než se ověří
const VERZE_MANIFESTU = 1;

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
  const odpovez = function (telo) { if (event.ports && event.ports[0]) event.ports[0].postMessage(telo); };
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'VERSION') odpovez(CACHE);
  if (data.type === 'ZKUS_AKTUALIZACI') {
    event.waitUntil(zkusAktualizaci(data).then(odpovez, function (e) {
      odpovez({ ok: false, duvod: 'necekana-chyba', text: String(e && e.message) });
    }));
  }
});

/* ════════════════════════════════════════════════════════════════════
   AKTUALIZACE — POŘADÍ, KTERÉ SE NESMÍ ZMĚNIT

     1. stáhnout manifest a balíček
     2. ověřit PODPIS manifestu
     3. ověřit OTISK každého staženého souboru
     4. ověřit NÁROK licence podle PODEPSANÉHO data vydání
     5. teprve pak uložit a nasadit

   Když cokoli z toho selže — špatný podpis, špatný otisk, nedostažený
   soubor, chyba při nasazení — nová verze se zahodí a běží dál ta stará.
   Data se přitom nikdy nemažou; aktualizace se jich vůbec nedotýká.

   Service worker si všechno ověřuje SÁM. Stránka mu jen podá licenční
   doklad; kdyby někdo obelhal stránku, service worker mu na to neskočí.
   ════════════════════════════════════════════════════════════════════ */

function zB64(s) {
  const b = atob(String(s)), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function doB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
/* Kanonický tvar — musí sedět bajt po bajtu s licence-server/klice.mjs
   i se src/licence.js: klíče podle abecedy, bez mezer, bez pole `podpis`. */
function kanonicky(o) {
  const serad = function (x) {
    if (Array.isArray(x)) return x.map(serad);
    if (x && typeof x === 'object') {
      const out = {};
      Object.keys(x).sort().forEach(function (k) { if (k !== 'podpis') out[k] = serad(x[k]); });
      return out;
    }
    return x;
  };
  return JSON.stringify(serad(o));
}
async function overPodpis(objekt, podpis, ucel) {
  try {
    if (!objekt || !podpis || !objekt.kid) return false;
    const zaznam = VEREJNE_KLICE.find(function (k) { return k.kid === objekt.kid && k.ucel === ucel; });
    if (!zaznam) return false;                    // neznámý nebo zneplatněný kid
    const klic = await crypto.subtle.importKey('spki', zB64(zaznam.klic),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const data = new TextEncoder().encode(kanonicky(objekt));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, klic, zB64(podpis), data);
  } catch (e) { return false; }
}
async function otisk(buf) {
  return 'sha256-' + doB64(await crypto.subtle.digest('SHA-256', buf));
}

function formatManifestu(m) {
  if (!m || typeof m !== 'object') return 'manifest-chybi';
  if (Number(m.v) !== VERZE_MANIFESTU) return 'nezname-verze-manifestu';
  if (m.kanal !== AKTUALIZACE.kanal) return 'jiny-kanal';
  if (!m.kid) return 'manifest-bez-kid';
  if (!Array.isArray(m.soubory) || !m.soubory.length) return 'manifest-bez-souboru';
  if (!Date.parse(String(m.vydano))) return 'manifest-bez-data-vydani';
  for (const s of m.soubory) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(s.cesta || ''))) return 'podezrela-cesta-v-manifestu';
    if (!/^sha256-[A-Za-z0-9+/=]+$/.test(String(s.otisk || ''))) return 'soubor-bez-otisku';
  }
  if (!m.soubory.some(function (s) { return s.cesta === 'index.html'; })) return 'manifest-bez-appky';
  return null;
}

/* Nárok se počítá z PODEPSANÉHO data vydání, ne z hodin v zařízení.
   Přetočením hodin dopředu si tedy nikdo novější verzi neodemkne. */
function narokNaVydani(m, doklad, schemaDat) {
  if (Number(m.minSchema || 1) > Number(schemaDat || 1)) return 'novejsi-datovy-format';
  if (doklad.stav && doklad.stav !== 'aktivni') return 'licence-neni-aktivni';
  if (Number(m.hlavniVerze) <= Number(doklad.hlavniVerze)) return null;   // zakoupená verze
  const konec = Date.parse(String(doklad.aktualizaceDo) + 'T23:59:59Z');
  const vydano = Date.parse(String(m.vydano));
  if (!isFinite(konec) || !isFinite(vydano)) return 'nesrozumitelna-data';
  return vydano <= konec ? null : 'vydano-po-konci-obdobi';
}

function adresaSouboru(cesta) {
  return AKTUALIZACE.puvod + '/vydani/' + AKTUALIZACE.kanal + '/' + cesta;
}
function vCache(rel) { return stripQuery(new URL(rel, self.location).href); }

async function zkusAktualizaci(zprava) {
  if (!AKTUALIZACE || !AKTUALIZACE.puvod) return { ok: false, duvod: 'aktualizace-nejsou-nastavene' };

  /* ── 1. licence: bez platného podpisu se nic nestahuje ───────────── */
  const lic = zprava && zprava.licence;
  if (!lic || !lic.doklad || !lic.podpis) return { ok: false, duvod: 'bez-licence' };
  if (!(await overPodpis(lic.doklad, lic.podpis, 'licence'))) return { ok: false, duvod: 'licence-neplatna' };

  /* ── 2. manifest ─────────────────────────────────────────────────── */
  let obalka;
  try {
    const r = await fetch(AKTUALIZACE.puvod + '/api/vydani', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licence: lic.doklad.licence, zarizeni: lic.doklad.zarizeni, kanal: AKTUALIZACE.kanal }),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    });
    if (r.status === 403) return { ok: false, duvod: 'zarizeni-odpojeno' };
    if (r.status === 404) return { ok: false, duvod: 'zatim-neni-co-stahovat' };
    if (!r.ok) return { ok: false, duvod: 'server-odpovedel-chybou', kod: r.status };
    obalka = JSON.parse(await r.text());
  } catch (e) {
    return { ok: false, duvod: 'server-nedostupny', offline: true };
  }

  const m = obalka && obalka.manifest;
  const chybaFormatu = formatManifestu(m);
  if (chybaFormatu) return { ok: false, duvod: chybaFormatu };

  /* ── 3. podpis manifestu ─────────────────────────────────────────── */
  if (!(await overPodpis(m, obalka.podpis, 'vydani'))) return { ok: false, duvod: 'podpis-manifestu-nesedi' };

  /* ── 4. nárok podle podepsaného data vydání ──────────────────────── */
  const bezNaroku = narokNaVydani(m, lic.doklad, zprava.schema);
  if (bezNaroku) return { ok: false, duvod: bezNaroku, verze: m.verze };

  /* ── 5. stažení do odkladiště a kontrola otisků ──────────────────── */
  await caches.delete(ODKLADISTE);                 // po dřívějším nezdaru tu nic zůstat nesmí
  const odkladiste = await caches.open(ODKLADISTE);
  try {
    for (const s of m.soubory) {
      const res = await fetch(new Request(adresaSouboru(s.cesta), { cache: 'no-store' }));
      if (!res || !res.ok) throw new Error('stazeni-selhalo:' + s.cesta);
      const buf = await res.arrayBuffer();
      if (s.velikost != null && buf.byteLength !== Number(s.velikost)) throw new Error('neuplne-stazeni:' + s.cesta);
      if (await otisk(buf) !== s.otisk) throw new Error('otisk-nesedi:' + s.cesta);
      await odkladiste.put(vCache('./' + s.cesta), new Response(buf, { status: 200 }));
    }
  } catch (e) {
    await caches.delete(ODKLADISTE);
    const [duvod, soubor] = String(e && e.message).split(':');
    return { ok: false, duvod: duvod || 'stazeni-selhalo', soubor: soubor };
  }

  /* ── 6. nasazení ─────────────────────────────────────────────────── */
  return nasad(m, odkladiste);
}

/* Přepis ověřených souborů do ostré mezipaměti. Před zápisem se pořídí
   záloha původních; kdyby zápis v půlce selhal, vrátí se zpátky a v
   telefonu zůstane celá stará verze, ne půlka od každé. */
async function nasad(m, odkladiste) {
  const cache = await caches.open(CACHE);
  const cile = [];
  for (const s of m.soubory) {
    cile.push([vCache('./' + s.cesta), s.cesta]);
    if (s.cesta === 'index.html') cile.push([vCache('./'), s.cesta]);   // start_url je index.html
  }
  const zaloha = new Map();
  try {
    for (const [url] of cile) {
      const stara = await cache.match(url);
      if (stara) zaloha.set(url, stara);
    }
    for (const [url, cesta] of cile) {
      const nova = await odkladiste.match(vCache('./' + cesta));
      if (!nova) throw new Error('chybi-v-odkladisti');
      await cache.put(url, nova);
    }
  } catch (e) {
    for (const [url, res] of zaloha) { try { await cache.put(url, res); } catch (x) { /* víc udělat nejde */ } }
    await caches.delete(ODKLADISTE);
    return { ok: false, duvod: 'nasazeni-selhalo' };
  }
  await caches.delete(ODKLADISTE);
  return { ok: true, verze: m.verze, vydano: m.vydano, souboru: m.soubory.length };
}

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
