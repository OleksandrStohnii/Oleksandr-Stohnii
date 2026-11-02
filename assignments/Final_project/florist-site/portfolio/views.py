from django.shortcuts import get_object_or_404, render

from .models import Category, Work


def home(request, category_id=None):
    categories = Category.objects.prefetch_related("works")
    works = Work.objects.select_related("category")
    current = None
    if category_id is not None:
        current = get_object_or_404(Category, pk=category_id)
        works = works.filter(category=current)

    with_photo = Work.objects.exclude(image="")
    hero_work = (
        with_photo.filter(is_hero=True).first()
        or with_photo.filter(category__name__contains="Весіл").first()
    )

    return render(request, "portfolio/home.html", {
        "categories": categories,
        "works": works,
        "current": current,
        "hero_work": hero_work,
    })