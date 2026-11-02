from django.db import models


class Category(models.Model):
    name = models.CharField("Назва", max_length=100)

    class Meta:
        verbose_name = "Категорія"
        verbose_name_plural = "Категорії"

    def __str__(self):
        return self.name


class Work(models.Model):
    title = models.CharField("Назва роботи", max_length=200)
    description = models.TextField("Опис", blank=True)
    category = models.ForeignKey(
        Category,
        on_delete=models.CASCADE,
        related_name="works",
        verbose_name="Категорія",
    )
    image = models.ImageField("Фото", upload_to="works/", blank=True)
    is_hero = models.BooleanField(
        "Фото для головного екрану",
        default=False,
        help_text="Позначте роботу з квітами: її фото буде на першому екрані сайту.",
    )
    created_at = models.DateTimeField("Дата додавання", auto_now_add=True)

    class Meta:
        verbose_name = "Робота"
        verbose_name_plural = "Роботи"
        ordering = ["-created_at"]

    def __str__(self):
        return self.title