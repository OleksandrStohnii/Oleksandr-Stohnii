from pathlib import Path

from PIL import Image

base = Path("portfolio/static/portfolio")
logo = Image.open(base / "logo.png").convert("RGBA")


def square(size, scale=1.0, background=(0, 0, 0, 0)):
    canvas = Image.new("RGBA", (size, size), background)
    inner = int(size * scale)
    resized = logo.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.alpha_composite(resized, (offset, offset))
    return canvas


milk = (247, 241, 234, 255)
square(192).save(base / "icon-192.png")
square(512).save(base / "icon-512.png")
square(512, 0.72, milk).save(base / "icon-512-maskable.png")
square(180, 0.86, milk).convert("RGB").save(base / "apple-touch-icon.png")
print("Иконки готовы")