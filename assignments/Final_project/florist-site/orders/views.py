import calendar
from collections import defaultdict
from datetime import date

from django.contrib import messages
from django.contrib.admin.views.decorators import staff_member_required
from django.core.exceptions import PermissionDenied
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils import timezone
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST

from .forms import OrderForm
from .models import BlockedDate, Order
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


def _back(request):
    target = request.POST.get("next", "")
    if not url_has_allowed_host_and_scheme(target, allowed_hosts={request.get_host()}):
        target = reverse("panel")
    return redirect(target)


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

    blocked = {b.date: b for b in BlockedDate.objects.filter(date__range=(start, end))}

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
                "blocked": blocked.get(day),
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
        "blocks": BlockedDate.objects.filter(date__gte=today)[:30],
        "today": today.isoformat(),
        "new_count": Order.objects.filter(status=Order.Status.NEW).count(),
        "confirmed_count": Order.objects.filter(
            status=Order.Status.CONFIRMED, event_date__gte=today
        ).count(),
    })


@staff_member_required
@require_POST
def set_status(request, pk):
    if not request.user.has_perm("orders.change_order"):
        raise PermissionDenied
    order = get_object_or_404(Order, pk=pk)
    new_status = request.POST.get("status")

    if new_status not in Order.Status.values:
        messages.error(request, "Невідомий статус.")
    else:
        order.status = new_status
        try:
            with transaction.atomic():
                order.save(update_fields=["status"])
        except IntegrityError:
            messages.error(
                request,
                "На цю дату вже є підтверджена заявка. Спочатку змініть її статус.",
            )
        else:
            messages.success(
                request,
                f"Заявку «{order.name}» переведено в статус: {order.get_status_display()}.",
            )
    return _back(request)


@staff_member_required
@require_POST
def block_date(request):
    if not request.user.has_perm("orders.add_blockeddate"):
        raise PermissionDenied
    try:
        day = date.fromisoformat(request.POST.get("date", ""))
    except ValueError:
        messages.error(request, "Оберіть коректну дату.")
        return _back(request)

    if day < timezone.localdate():
        messages.error(request, "Не можна закрити дату, яка вже минула.")
        return _back(request)

    reason = request.POST.get("reason", "").strip()[:120]
    _, created = BlockedDate.objects.get_or_create(date=day, defaults={"reason": reason})
    if not created:
        messages.error(request, "Ця дата вже закрита.")
    else:
        messages.success(request, f"Дату {day:%d.%m.%Y} закрито для нових заявок.")
        if Order.objects.filter(event_date=day, status=Order.Status.CONFIRMED).exists():
            messages.warning(
                request,
                "Увага: на цю дату вже є підтверджена заявка, вона залишилась без змін.",
            )
    return _back(request)


@staff_member_required
@require_POST
def unblock_date(request, pk):
    if not request.user.has_perm("orders.delete_blockeddate"):
        raise PermissionDenied
    block = get_object_or_404(BlockedDate, pk=pk)
    label = f"{block.date:%d.%m.%Y}"
    block.delete()
    messages.success(request, f"Дату {label} знову відкрито для заявок.")
    return _back(request)