import json
import logging
import os
import urllib.request
from pathlib import Path

from django.conf import settings

logger = logging.getLogger(__name__)


def _env(name):
    value = os.environ.get(name)
    if value:
        return value
    path = Path(settings.BASE_DIR) / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return None


def send_message(text):
    token = _env("TELEGRAM_BOT_TOKEN")
    chat_id = _env("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        logger.warning("Telegram не налаштований: немає токена або chat id")
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": text}).encode("utf-8")
    request = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(request, timeout=5).close()
        return True
    except Exception as exc:
        logger.warning("Не вдалося надіслати в Telegram: %s", type(exc).__name__)
        return False


def notify_new_order(order):
    text = (
        "🌸 Нова заявка на сайті Zolotaya\n\n"
        f"Ім'я: {order.name}\n"
        f"Телефон: {order.phone}\n"
        f"Подія: {order.get_event_type_display()}\n"
        f"Дата: {order.event_date:%d.%m.%Y}\n"
        f"Побажання: {order.message or '—'}"
    )
    return send_message(text)