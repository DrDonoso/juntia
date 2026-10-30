import io
from decimal import Decimal

from reportlab.pdfgen.canvas import Canvas


def iban(suffix: str = "0000000001") -> str:
    # Fictitious domestic account on the unassigned bank code 9999, with a valid IBAN checksum.
    domestic = "9999000100" + suffix
    return f"ES{98 - int(domestic + '142800') % 97:02d}{domestic}"


ROWS = [
    ("02/10/26", "02/10/26", "Cleaning receipt", "-20.00", "150.00"),
    ("01/10/26", "02/10/26", "Electricity receipt", "-30.00", "170.00"),
    ("30/09/26", "30/09/26", "Community contribution", "200.00", "200.00"),
]


def localized(value: str) -> str:
    amount = Decimal(value)
    text = f"{abs(amount):,.2f}".replace(",", "_").replace(".", ",").replace("_", ".")
    return ("- " if amount < 0 else "") + text + " €"


def statement_pdf(rows=None, account=None, shifted=True, extra_header="", pages=None) -> bytes:
    output = io.BytesIO()
    canvas = Canvas(output, pagesize=(595, 842), invariant=1)
    page_rows = pages or [ROWS if rows is None else rows]
    for page_index, group in enumerate(page_rows):
        canvas.setFont("Helvetica", 8)
        canvas.drawString(40, 808, "Account statement")
        canvas.drawString(40, 790, iban() if account is None else account)
        if extra_header:
            canvas.drawString(40, 776, extra_header)
        for x, label in [
            (40, "Data"),
            (80, "Valor"),
            (120, "Concepte"),
            (470, "Import +/- (€)"),
            (535, "Saldo (€)"),
        ]:
            canvas.drawString(x, 745, label)
        canvas.setFont("Helvetica", 7)
        for index, (booking, value, description, amount, balance) in enumerate(group):
            y = 727 - index * 14
            canvas.drawString(40, y, booking)
            canvas.drawString(80, y, value)
            canvas.drawString(120, y, description)
            canvas.drawRightString(516, y - (index * 2 if shifted else 0), localized(amount))
            canvas.drawRightString(575, y, localized(balance))
        canvas.drawString(40, 30, f"https://bank.example/statement/{page_index}")
        canvas.showPage()
    canvas.save()
    return output.getvalue()
