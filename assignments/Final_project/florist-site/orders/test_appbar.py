from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class AppBarTests(TestCase):
    def test_home_has_app_bar(self):
        response = self.client.get(reverse("home"))
        self.assertContains(response, 'class="appbar"')

    def test_admin_login_has_app_bar(self):
        response = self.client.get("/admin/login/")
        self.assertContains(response, 'class="appbar"')

    def test_panel_has_app_bar(self):
        user = get_user_model().objects.create_user(
            "alina", password="pass-12345", is_staff=True
        )
        self.client.force_login(user)
        response = self.client.get(reverse("panel"))
        self.assertContains(response, 'class="appbar"')