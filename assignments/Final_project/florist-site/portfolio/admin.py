from django.contrib import admin

from .models import Category, Work


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    list_display = ("name",)


@admin.register(Work)
class WorkAdmin(admin.ModelAdmin):
    list_display = ("title", "category", "is_hero", "created_at")
    list_filter = ("category", "is_hero")
    search_fields = ("title",)
    list_editable = ("is_hero",)