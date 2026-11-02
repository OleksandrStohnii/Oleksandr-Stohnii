from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import BlockedDate


class BlockedDateTests(TestCase):
    def setUp(self):
        self.boss = get_user_model().objects.create_superuser(
            "boss", password="pass-12345"
        )
        self.client.force_login(self.boss)
        self.day = timezone.localdate() + timedelta(days=15)

    def test_form_rejects_blocked_date(self):
        BlockedDate.objects.create(date=self.day, reason="Відпустка")
        with patch("orders.views.notify_new_order"):
            response = self.client.post(reverse("order_create"), {
                "name": "Марія", "phone": "+380501112233",
                "event_type": "wedding", "event_date": self.day.isoformat(),
                "message": "",
            })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "запис закрито")

    def test_owner_can_block_a_date(self):
        self.client.post(reverse("panel_block"), {
            "date": self.day.isoformat(), "reason": "Відпустка",
        })
        self.assertTrue(BlockedDate.objects.filter(date=self.day).exists())

    def test_blocking_twice_does_not_crash(self):
        data = {"date": self.day.isoformat(), "reason": "Вихідний"}
        self.client.post(reverse("panel_block"), data)
        self.client.post(reverse("panel_block"), data)
        self.assertEqual(BlockedDate.objects.count(), 1)

    def test_past_date_cannot_be_blocked(self):
        past = timezone.localdate() - timedelta(days=1)
        self.client.post(reverse("panel_block"), {"date": past.isoformat()})
        self.assertEqual(BlockedDate.objects.count(), 0)

    def test_owner_can_unblock_a_date(self):
        block = BlockedDate.objects.create(date=self.day)
        self.client.post(reverse("panel_unblock", args=[block.pk]))
        self.assertEqual(BlockedDate.objects.count(), 0)

    def test_staff_without_permission_cannot_block(self):
        weak = get_user_model().objects.create_user(
            "guest", password="pass-12345", is_staff=True
        )
        self.client.force_login(weak)
        response = self.client.post(reverse("panel_block"), {
            "date": self.day.isoformat(),
        })
        self.assertEqual(response.status_code, 403)
        self.assertEqual(BlockedDate.objects.count(), 0)