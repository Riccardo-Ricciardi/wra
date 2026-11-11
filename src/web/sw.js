// Service worker: serve a due cose sole, e nient'altro.
//
//   1. rendere l'app installabile e apribile anche senza rete (la shell: pagina, stili, script);
//   2. non far mai vedere una pagina bianca quando la rete cade — si apre la conversazione
//      dell'ultima volta e si dice che si è offline.
//
// Non tocca mai le API, il websocket o MCP: quelli o sono vivi, o non lo sono, e una risposta
// vecchia sarebbe peggio di un errore. Nessuna strategia furba: la shell si tiene, il resto va
// in rete e basta.

const VERSION = 'cc-remote-v11';
// Tutti i moduli che `app.js` importa, uno per uno: se ne manca uno, la prima apertura senza rete
// non carica l'app (i moduli non ancora in cache rispondono 504, e la pagina resta vuota). Il
// guscio è l'insieme dei file di codice, non solo due di essi.
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/state/api.mjs',
  '/state/socket.mjs',
  '/ui/dom.mjs',
  '/ui/icons.mjs',
  '/ui/anchor.mjs',
  '/core/markdown.mjs',
  '/core/ordering.mjs',
  '/core/authorization.mjs',
  '/core/format.mjs',
  '/core/session-view.mjs',
  '/core/registry-hygiene.mjs',
  '/ui/terminal-reset.mjs',
  '/ui/views/activity.mjs',
  '/ui/views/admin.mjs',
  '/ui/views/chat.mjs',
  '/ui/views/terminal.mjs',
  '/ui/views/shell.mjs',
  '/ui/views/list.mjs',
  '/ui/views/selection.mjs',
  '/ui/views/projects.mjs',
  '/ui/views/permissions.mjs',
  '/fonts/geist.woff2',
  '/fonts/geist-mono.woff2',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/xterm/css/xterm.css',
  '/vendor/xterm/lib/xterm.mjs',
  '/vendor/fit/lib/addon-fit.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Uno per volta e senza far fallire tutto: se un file manca, l'installazione deve riuscire
    // lo stesso — meglio un'app senza un pezzo in cache che un'app che non si installa.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Quello che non si mette mai in cache: roba viva, o roba di sicurezza. */
const neverCache = (url) => url.pathname.startsWith('/local/')
  || url.pathname.startsWith('/mcp')
  || url.pathname.startsWith('/.well-known/')
  || url.pathname.startsWith('/ws')
  || url.pathname.startsWith('/authorize')
  || url.pathname === '/healthz'
  || url.pathname === '/register'
  || url.pathname === '/token'
  || url.pathname === '/revoke';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (neverCache(url)) return;

  // La pagina: prima la rete (così un aggiornamento si vede subito), e se non c'è si apre
  // quella in cache — che è la shell, non una conversazione vecchia: i messaggi arrivano dal
  // websocket, e senza rete non arrivano.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(VERSION);
        cache.put('/', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('/');
        return cached ?? new Response('WRA: no network and no local copy', {
          status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // Gli altri file: si serve la copia buona e si aggiorna dietro le quinte.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    }).catch(() => null);
    return cached ?? (await network) ?? new Response('', { status: 504 });
  })());
});
