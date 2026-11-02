from django.shortcuts import redirect, render

from .forms import OrderForm
from .telegram import notify_new_order


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