from django.test import TestCase
from django.urls import reverse

from .models import Category, Work


class CatalogTests(TestCase):
    def setUp(self):
        self.wedding = Category.objects.create(name="Весілля")
        self.kids = Category.objects.create(name="Дитячі майстер-класи")
        Work.objects.create(title="Арка для церемонії", category=self.wedding)
        Work.objects.create(title="Тематичний стіл", category=self.kids)

    def test_home_opens_and_shows_categories(self):
        response = self.client.get(reverse("home"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Весілля")
        self.assertContains(response, "Арка для церемонії")
        self.assertContains(response, "Тематичний стіл")

    def test_category_filter_shows_only_its_works(self):
        response = self.client.get(reverse("category", args=[self.wedding.id]))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Арка для церемонії")
        self.assertNotContains(response, "Тематичний стіл")

    def test_unknown_category_returns_404(self):
        response = self.client.get(reverse("category", args=[9999]))
        self.assertEqual(response.status_code, 404)