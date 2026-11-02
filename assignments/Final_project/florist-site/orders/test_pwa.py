from django.test import TestCase
from django.urls import reverse


class PwaTests(TestCase):
    def test_manifest_is_public_and_describes_an_app(self):
        response = self.client.get(reverse("panel_manifest"))
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["display"], "standalone")
        self.assertEqual(data["start_url"], "/panel/")
        sizes = {icon["sizes"] for icon in data["icons"]}
        self.assertIn("192x192", sizes)
        self.assertIn("512x512", sizes)

    def test_service_worker_is_public_javascript(self):
        response = self.client.get(reverse("panel_sw"))
        self.assertEqual(response.status_code, 200)
        self.assertIn("javascript", response["Content-Type"])

    def test_offline_page_opens_without_login(self):
        response = self.client.get(reverse("panel_offline"))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Немає зв'язку")