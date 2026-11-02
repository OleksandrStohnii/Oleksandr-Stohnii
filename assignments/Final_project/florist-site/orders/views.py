import calendar
from collections import defaultdict
from datetime import date

from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import redirect, render
from django.utils import timezone

from .forms import OrderForm
from .models import Order
from .telegram import notify_new_order

MONTHS = [
    "Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень",
]
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"]


def create_order(request):
    if request.method == "POST":
        form = OrderForm(request.POST)
        if form.is_valid():
            order = form.save()
            notify_new_order(order)
            return redirect("order_success")
    else:
        form = OrderForm()
    return render(request, "orders/order_form.html", {"form": form})


def order_success(request):
    return render(request, "orders/order_success.html")


def _month_from_request(request):
    raw = request.GET.get("month", "")
    try:
        year, month = (int(part) for part in raw.split("-"))
        return date(year, month, 1)
    except ValueError:
        return timezone.localdate().replace(day=1)


def _shift(first, delta):
    index = first.year * 12 + first.month - 1 + delta
    return date(index // 12, index % 12 + 1, 1)


@staff_member_required
def panel(request):
    today = timezone.localdate()
    first = _month_from_request(request)
    weeks_dates = calendar.Calendar(firstweekday=0).monthdatescalendar(
        first.year, first.month
    )
    start, end = weeks_dates[0][0], weeks_dates[-1][-1]

    by_day = defaultdict(list)
    month_orders = Order.objects.filter(event_date__range=(start, end)).exclude(
        status=Order.Status.CANCELLED
    )
    for order in month_orders:
        by_day[order.event_date].append(order)

    weeks = []
    for week in weeks_dates:
        row = []
        for day in week:
            orders = by_day.get(day, [])
            row.append({
                "date": day,
                "in_month": day.month == first.month,
                "is_today": day == today,
                "orders": orders,
                "confirmed": any(o.status == Order.Status.CONFIRMED for o in orders),
            })
        weeks.append(row)

    upcoming = (
        Order.objects.filter(event_date__gte=today)
        .exclude(status__in=[Order.Status.CANCELLED, Order.Status.DONE])
        .order_by("event_date", "created_at")[:30]
    )

    return render(request, "orders/panel.html", {
        "weeks": weeks,
        "weekdays": WEEKDAYS,
        "month_title": f"{MONTHS[first.month - 1]} {first.year}",
        "prev_month": _shift(first, -1).strftime("%Y-%m"),
        "next_month": _shift(first, 1).strftime("%Y-%m"),
        "upcoming": upcoming,
        "new_count": Order.objects.filter(status=Order.Status.NEW).count(),
        "confirmed_count": Order.objects.filter(
            status=Order.Status.CONFIRMED, event_date__gte=today
        ).count(),
    })