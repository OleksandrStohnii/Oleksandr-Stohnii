from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from orders.pwa import manifest, offline, service_worker
from orders.views import panel

urlpatterns = [
    path("admin/", admin.site.urls),
    path("panel/", panel, name="panel"),
    path("panel/manifest.webmanifest", manifest, name="panel_manifest"),
    path("panel/offline/", offline, name="panel_offline"),
    path("panel-sw.js", service_worker, name="panel_sw"),
    path("order/", include("orders.urls")),
    path("", include("portfolio.urls")),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)