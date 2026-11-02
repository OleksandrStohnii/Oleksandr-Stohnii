from django.shortcuts import get_object_or_404, render

from .models import Category, Work


def home(request, category_id=None):
    categories = Category.objects.prefetch_related("works")
    works = Work.objects.select_related("category")
    current = None
    if category_id is not None:
        current = get_object_or_404(Category, pk=category_id)
        works = works.filter(category=current)
    return render(request, "portfolio/home.html", {
        "categories": categories,
        "works": works,
        "current": current,
    })