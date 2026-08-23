const CACHE_NAME = "pwa-klavir-v166";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=166",
  "./js/state.js",
  "./js/audio.js?v=166",
  "./js/chord-analysis.js?v=166",
  "./js/chord-editor.js?v=166",
  "./js/keyboard.js",
  "./js/mp3-metadata.js?v=166",
  "./js/pcm-wav.js?v=166",
  "./js/waveform.js?v=166",
  "./js/midi.js",
  "./js/github.js",
  "./js/preferences.js?v=166",
  "./js/practice-timing.js?v=166",
  "./js/processing-client.js?v=166",
  "./js/analysis-progress.js?v=166",
  "./js/melody-fingering.js?v=166",
  "./js/melody-phrases.js?v=166",
  "./js/mixer-routing.js?v=166",
  "./js/beat-grid.js?v=166",
  "./js/score-player.js?v=166",
  "./js/piano-voice.js?v=166",
  "./js/voicing.js?v=166",
  "./js/audio-import.js?v=166",
  "./js/pcm-capture.js?v=166",
  "./js/pcm-capture-worklet.js?v=166",
  "./js/ui-tools.js?v=166",
  "./js/ui-controller.js?v=166",
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
  "./Luis%20-%20Sve%20se%20osim%20tuge%20deli%20-%20Amol.mp3",
  "./samples/luis-sve-se-osim-tuge-deli/note-tracks.json",
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
    // Network-first is only network-first if the request actually reaches the
    // network. Without this the browser's own HTTP cache answers instead, and
    // a freshly deployed index.html keeps loading the previous version's
    // modules — the page reports the new cache name while running the old
    // code, which is indistinguishable from the update not working at all.
    event.respondWith(
      fetch(new Request(event.request, { cache: "no-store" }))
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
