from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

from orders.pwa import manifest, offline, service_worker
from orders.views import block_date, panel, set_status, unblock_date

urlpatterns = [
    path("admin/", admin.site.urls),
    path("panel/", panel, name="panel"),
    path("panel/status/<int:pk>/", set_status, name="panel_status"),
    path("panel/block/", block_date, name="panel_block"),
    path("panel/unblock/<int:pk>/", unblock_date, name="panel_unblock"),
    path("panel/manifest.webmanifest", manifest, name="panel_manifest"),
    path("panel/offline/", offline, name="panel_offline"),
    path("panel-sw.js", service_worker, name="panel_sw"),
    path("order/", include("orders.urls")),
    path("", include("portfolio.urls")),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)