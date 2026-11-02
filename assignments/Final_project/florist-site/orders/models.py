from django.db import models


class Order(models.Model):
    class EventType(models.TextChoices):
        WEDDING = "wedding", "Весілля"
        VENUE = "venue", "Оформлення закладу"
        HALLOWEEN = "halloween", "Гелловін"
        NEW_YEAR = "new_year", "Новий рік"
        KIDS = "kids", "Дитячий майстер-клас"
        OTHER = "other", "Інше"

    class Status(models.TextChoices):
        NEW = "new", "Нова"
        IN_PROGRESS = "in_progress", "В роботі"
        CONFIRMED = "confirmed", "Підтверджена"
        DONE = "done", "Виконана"
        CANCELLED = "cancelled", "Скасована"

    name = models.CharField("Ім'я", max_length=100)
    phone = models.CharField("Телефон", max_length=30)
    event_type = models.CharField(
        "Тип події", max_length=20, choices=EventType.choices
    )
    event_date = models.DateField("Дата події")
    message = models.TextField("Побажання", blank=True)
    status = models.CharField(
        "Статус", max_length=20, choices=Status.choices, default=Status.NEW
    )
    created_at = models.DateTimeField("Дата заявки", auto_now_add=True)

    class Meta:
        verbose_name = "Заявка"
        verbose_name_plural = "Заявки"
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event_date"],
                condition=models.Q(status="confirmed"),
                name="unique_confirmed_order_per_date",
                violation_error_message="На цю дату вже є підтверджена заявка.",
            )
        ]

    def __str__(self):
        return f"{self.name} - {self.get_event_type_display()} ({self.event_date})"