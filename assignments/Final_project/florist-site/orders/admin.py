from django.contrib import admin

from .models import BlockedDate, Order


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ("name", "phone", "event_type", "event_date", "status", "created_at")
    list_filter = ("status", "event_type")
    search_fields = ("name", "phone")
    list_editable = ("status",)


@admin.register(BlockedDate)
class BlockedDateAdmin(admin.ModelAdmin):
    list_display = ("date", "reason")