from datetime import date

from django import forms

from .models import Order


class OrderForm(forms.ModelForm):
    class Meta:
        model = Order
        fields = ["name", "phone", "event_type", "event_date", "message"]
        widgets = {
            "event_date": forms.DateInput(attrs={"type": "date"}),
            "message": forms.Textarea(attrs={"rows": 4}),
        }

    def clean_event_date(self):
        chosen = self.cleaned_data["event_date"]
        if chosen < date.today():
            raise forms.ValidationError("Оберіть дату, яка ще не минула.")
        if Order.objects.filter(
            event_date=chosen, status=Order.Status.CONFIRMED
        ).exists():
            raise forms.ValidationError(
                "На цю дату вже є підтверджене замовлення. Оберіть, будь ласка, іншу дату."
            )
        return chosen