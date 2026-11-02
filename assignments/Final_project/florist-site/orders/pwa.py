from django.http import HttpResponse, JsonResponse
from django.templatetags.static import static
from django.views.decorators.cache import never_cache

SERVICE_WORKER = """
const CACHE = 'zolotaya-panel-v1';
const OFFLINE = '/panel/offline/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.mode === 'navigate' && url.origin === self.location.origin && url.pathname.startsWith('/panel')) {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
  }
});
"""

OFFLINE_HTML = """<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Немає зв'язку</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F7F1EA;color:#1E2A4A;font-family:Arial,sans-serif;text-align:center;padding:24px}
h1{font-family:Georgia,serif;font-size:30px;margin:0 0 12px}p{color:#4F5A73;margin:0 0 28px}
button{background:#9C7A6B;color:#fff;border:0;border-radius:999px;padding:16px 34px;font-size:14px;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
</style></head><body><div>
<h1>Немає зв'язку</h1>
<p>Заявки з'являться в панелі, щойно інтернет повернеться.</p>
<button onclick="location.reload()">Спробувати ще раз</button>
</div></body></html>"""


def manifest(request):
    data = {
        "name": "Zolotaya Панель",
        "short_name": "Zolotaya",
        "description": "Календар і заявки флориста Zolotaya",
        "lang": "uk",
        "start_url": "/panel/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#F7F1EA",
        "theme_color": "#9C7A6B",
        "icons": [
            {"src": static("portfolio/icon-192.png"), "sizes": "192x192",
             "type": "image/png", "purpose": "any"},
            {"src": static("portfolio/icon-512.png"), "sizes": "512x512",
             "type": "image/png", "purpose": "any"},
            {"src": static("portfolio/icon-512-maskable.png"), "sizes": "512x512",
             "type": "image/png", "purpose": "maskable"},
        ],
    }
    return JsonResponse(
        data,
        content_type="application/manifest+json",
        json_dumps_params={"ensure_ascii": False},
    )


@never_cache
def service_worker(request):
    response = HttpResponse(SERVICE_WORKER, content_type="application/javascript")
    response["Service-Worker-Allowed"] = "/"
    return response


def offline(request):
    return HttpResponse(OFFLINE_HTML)