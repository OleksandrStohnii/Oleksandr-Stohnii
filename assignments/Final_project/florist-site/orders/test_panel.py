from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Order


class PanelTests(TestCase):
    def staff(self):
        user = get_user_model().objects.create_user(
            "alina", password="pass-12345", is_staff=True
        )
        self.client.force_login(user)

    def test_anonymous_user_is_redirected_to_login(self):
        response = self.client.get(reverse("panel"))
        self.assertEqual(response.status_code, 302)
        self.assertIn("login", response.url)

    def test_staff_sees_calendar_with_orders(self):
        self.staff()
        Order.objects.create(
            name="Олена", phone="+380991112233", event_type="wedding",
            event_date=timezone.localdate(),
        )
        response = self.client.get(reverse("panel"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Олена")

    def test_broken_month_parameter_does_not_crash(self):
        self.staff()
        response = self.client.get(reverse("panel") + "?month=abc")
        self.assertEqual(response.status_code, 200)