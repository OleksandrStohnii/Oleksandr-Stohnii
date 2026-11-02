import json
import urllib.error
import urllib.request
from pathlib import Path


def read_token():
    for line in Path(".env").read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith("TELEGRAM_BOT_TOKEN="):
            return line.split("=", 1)[1].strip()
    return None


token = read_token()
if not token:
    raise SystemExit("В файле .env нет строки TELEGRAM_BOT_TOKEN=...")

url = f"https://api.telegram.org/bot{token}/getUpdates"
try:
    with urllib.request.urlopen(url, timeout=15) as response:
        data = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(f"Telegram ответил ошибкой {error.code}. Проверьте токен в .env.")
except urllib.error.URLError as error:
    raise SystemExit(f"Нет связи с Telegram: {error.reason}")

seen = set()
for update in data.get("result", []):
    message = update.get("message")
    if not message:
        continue
    chat = message["chat"]
    if chat["id"] in seen:
        continue
    seen.add(chat["id"])
    name = chat.get("first_name") or chat.get("title") or ""
    print("chat id:", chat["id"], "| имя:", name, "| username:", chat.get("username"))

if not seen:
    print("Сообщений пока нет. Отправьте боту любое слово в Telegram и запустите снова.")