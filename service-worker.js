const CACHE_NAME = "pwa-klavir-v95";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=95",
  "./js/state.js",
  "./js/audio.js",
  "./js/keyboard.js",
  "./js/midi.js",
  "./js/github.js",
  "./js/ui-tools.js",
  "./js/ui-controller.js",
  "./manifest.webmanifest",
  "./repertoire.json",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./chord-lab.html",
  "./capture-lab.html",
  "./midi-lab.html"
];

const SAMPLE_ASSETS = [
  "./samples/piano/A0v12.mp3",
  "./samples/piano/A1v12.mp3",
  "./samples/piano/A2v12.mp3",
  "./samples/piano/A3v12.mp3",
  "./samples/piano/A4v12.mp3",
  "./samples/piano/A5v12.mp3",
  "./samples/piano/A6v12.mp3",
  "./samples/piano/A7v12.mp3",
  "./samples/piano/C1v12.mp3",
  "./samples/piano/C2v12.mp3",
  "./samples/piano/C3v12.mp3",
  "./samples/piano/C4v12.mp3",
  "./samples/piano/C5v12.mp3",
  "./samples/piano/C6v12.mp3",
  "./samples/piano/C7v12.mp3",
  "./samples/piano/C8v12.mp3",
  "./samples/piano/D%231v12.mp3",
  "./samples/piano/D%232v12.mp3",
  "./samples/piano/D%233v12.mp3",
  "./samples/piano/D%234v12.mp3",
  "./samples/piano/D%235v12.mp3",
  "./samples/piano/D%236v12.mp3",
  "./samples/piano/D%237v12.mp3",
  "./samples/piano/F%231v12.mp3",
  "./samples/piano/F%232v12.mp3",
  "./samples/piano/F%233v12.mp3",
  "./samples/piano/F%234v12.mp3",
  "./samples/piano/F%235v12.mp3",
  "./samples/piano/F%236v12.mp3",
  "./samples/piano/F%237v12.mp3",
  "./samples/piano/LICENSE.audio-samples-piano-mp3-velocity12.txt",
  "./samples/piano/NOTICE.txt",
  "./samples/piano/README.audio-samples-piano-mp3-velocity12.md"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS);
      await Promise.allSettled(SAMPLE_ASSETS.map((asset) => cache.add(asset)));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  const isAppShell =
    event.request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.includes("/js/") ||
    url.pathname.endsWith("/styles.css") ||
    url.pathname.endsWith("/service-worker.js") ||
    url.pathname.endsWith(".html");

  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
