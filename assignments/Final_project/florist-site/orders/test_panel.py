from datetime import timedelta

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


class StatusButtonTests(TestCase):
    def setUp(self):
        self.boss = get_user_model().objects.create_superuser(
            "boss", password="pass-12345"
        )
        self.client.force_login(self.boss)
        self.day = timezone.localdate() + timedelta(days=20)

    def make(self, **kwargs):
        data = {
            "name": "Олена", "phone": "+380991112233",
            "event_type": "wedding", "event_date": self.day,
        }
        data.update(kwargs)
        return Order.objects.create(**data)

    def post_status(self, order, status):
        return self.client.post(
            reverse("panel_status", args=[order.pk]), {"status": status}
        )

    def test_status_is_changed(self):
        order = self.make()
        response = self.post_status(order, "confirmed")
        self.assertRedirects(response, reverse("panel"))
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.CONFIRMED)

    def test_second_confirmed_order_on_same_date_is_refused(self):
        self.make(status=Order.Status.CONFIRMED)
        second = self.make(name="Анна")
        response = self.post_status(second, "confirmed")
        self.assertEqual(response.status_code, 302)
        second.refresh_from_db()
        self.assertEqual(second.status, Order.Status.NEW)

    def test_unknown_status_is_ignored(self):
        order = self.make()
        self.post_status(order, "hacked")
        order.refresh_from_db()
        self.assertEqual(order.status, Order.Status.NEW)

    def test_get_request_is_not_allowed(self):
        order = self.make()
        response = self.client.get(reverse("panel_status", args=[order.pk]))
        self.assertEqual(response.status_code, 405)

    def test_staff_without_permission_gets_403(self):
        order = self.make()
        weak = get_user_model().objects.create_user(
            "guest", password="pass-12345", is_staff=True
        )
        self.client.force_login(weak)
        response = self.post_status(order, "confirmed")
        self.assertEqual(response.status_code, 403)

    def test_anonymous_user_cannot_change_status(self):
        order = self.make()
        self.client.logout()
        response = self.post_status(order, "confirmed")
        self.assertEqual(response.status_code, 302)
        self.assertIn("login", response.url)