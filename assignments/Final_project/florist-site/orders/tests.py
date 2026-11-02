from datetime import timedelta

from django.db import IntegrityError, transaction
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import Order


def future(days=30):
    return timezone.localdate() + timedelta(days=days)


def make_order(**kwargs):
    data = {
        "name": "Олена",
        "phone": "+380991112233",
        "event_type": Order.EventType.WEDDING,
        "event_date": future(),
    }
    data.update(kwargs)
    return Order.objects.create(**data)


class OrderFormTests(TestCase):
    url = reverse("order_create")

    def payload(self, **kwargs):
        data = {
            "name": "Марія",
            "phone": "+380501112233",
            "event_type": "wedding",
            "event_date": future().isoformat(),
            "message": "Арка з евкаліптом",
        }
        data.update(kwargs)
        return data

    def test_form_page_opens(self):
        self.assertEqual(self.client.get(self.url).status_code, 200)

    def test_valid_order_is_saved_as_new(self):
        response = self.client.post(self.url, self.payload())
        self.assertRedirects(response, reverse("order_success"))
        order = Order.objects.get()
        self.assertEqual(order.name, "Марія")
        self.assertEqual(order.status, Order.Status.NEW)

    def test_empty_name_is_rejected(self):
        response = self.client.post(self.url, self.payload(name=""))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.count(), 0)

    def test_past_date_is_rejected(self):
        past = (timezone.localdate() - timedelta(days=1)).isoformat()
        response = self.client.post(self.url, self.payload(event_date=past))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.count(), 0)

    def test_busy_date_is_rejected(self):
        make_order(status=Order.Status.CONFIRMED)
        response = self.client.post(self.url, self.payload())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(Order.objects.count(), 1)


class BookingRuleTests(TestCase):
    def test_two_new_orders_on_same_date_are_allowed(self):
        make_order()
        make_order(name="Анна")
        self.assertEqual(Order.objects.count(), 2)

    def test_cancelled_order_does_not_block_date(self):
        make_order(status=Order.Status.CANCELLED)
        make_order(name="Анна", status=Order.Status.CONFIRMED)
        self.assertEqual(Order.objects.count(), 2)

    def test_database_forbids_two_confirmed_orders_on_same_date(self):
        make_order(status=Order.Status.CONFIRMED)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                make_order(name="Анна", status=Order.Status.CONFIRMED)