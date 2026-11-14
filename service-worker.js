const CACHE_NAME = "ms-store-customer-v2";
const BASE_PATH = "/ms-store/";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([
        BASE_PATH,
        BASE_PATH + "index.html"
      ]);
    })
  );

  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {

  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // HTML Navigation: Always try the latest website first
  if (request.mode === "navigate") {

    event.respondWith(
      fetch(request, { cache: "no-store" })
        .catch(async () => {

          const cached = await caches.match(request);

          if (cached) return cached;

          // Only use Shop Page for the homepage
          if (
            url.pathname === BASE_PATH ||
            url.pathname === BASE_PATH + "index.html"
          ) {
            const home = await caches.match(BASE_PATH);

            if (home) return home;
          }

          return new Response(
            "Page unavailable. Please check your internet connection.",
            {
              status: 503,
              headers: {
                "Content-Type": "text/plain; charset=utf-8"
              }
            }
          );

        })
    );

    return;
  }

  // Other files: Network first, cache as fallback
  event.respondWith(

    fetch(request)
      .then(response => {

        if (response && response.ok) {

          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });

        }

        return response;

      })
      .catch(async () => {

        const cached = await caches.match(request);

        if (cached) return cached;

        return Response.error();

      })

  );

});
