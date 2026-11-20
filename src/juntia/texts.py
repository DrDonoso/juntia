"""Server-generated texts in the language configured by APP_LANGUAGE.

The web interface follows each browser's language; these texts cover what the server writes
itself: emails, first-run defaults, fallback labels and the technical administrator's author label.
Push notifications use them too, in the language of the interface on each device.
"""

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request

from .config import Language


@dataclass(frozen=True)
class Texts:
    administrator: str
    community_name: str
    account_name: str
    uncategorized: str
    no_merchant: str
    manifest_description: str
    categories: tuple[str, ...]
    tags: tuple[str, ...]
    invitation_subject: str
    recovery_subject: str
    greeting: str
    invitation: str
    invitation_method: str
    invitation_method_google: str
    recovery: str
    invitation_lifetime: str
    recovery_lifetime: str
    single_use: str
    unexpected: str
    password_notice: str
    # The name of a ZIP of documents from several folders, and the mark of an earlier version.
    documents: str
    document_version: str
    # Push notifications (notifications.py), in the language of each device: the months, a month
    # of a year ("{month} {year}"), and each kind's title and text.
    months: tuple[str, ...]
    month_year: str
    statement_missing_title: str
    statement_missing_body: str
    accounts_ready_title: str
    accounts_ready_body: str
    # The statuses of actions as the portal shows them, in the order of ``ACTION_STATUSES``.
    action_statuses: tuple[str, ...]
    action_created_title: str
    action_created_body: str
    action_status_body: str
    # What is new on an action: one comment or PDF by its author, or how many of each ("{count}"
    # of one, or of several), alone or together.
    comment_added: str
    attachment_added: str
    comments_one: str
    comments_many: str
    attachments_one: str
    attachments_many: str
    contributions: str
    contributions_both: str
    # The days of the week from Monday, and the day an event starts ("Thursday 4 December"), in
    # another year with it.
    weekdays: tuple[str, ...]
    event_day: str
    event_day_year: str
    event_created: str
    event_changed: str
    event_cancelled: str
    reminder_today: str
    reminder_tomorrow: str
    reminder: str


TEXTS: dict[Language, Texts] = {
    "en": Texts(
        administrator="Technical administrator",
        community_name="Residential community",
        account_name="Community account",
        uncategorized="Uncategorized",
        no_merchant="No merchant",
        manifest_description="Community finances, actions and events.",
        categories=(
            "Regular fees", "Special assessments", "Water", "Electricity", "Cleaning",
            "Maintenance", "Repairs", "Administration", "Insurance", "Professional services",
            "Taxes", "Bank fees", "Other",
        ),
        tags=("Recurring", "Extraordinary", "Refund", "Transfer", "Direct debit", "Review"),
        invitation_subject="Your invitation to Juntia",
        recovery_subject="Reset your Juntia password",
        greeting="Hello {name},",
        invitation=(
            "You have been invited to join {community}. "
            "Activate your account with {method} using this link:"
        ),
        invitation_method="a password",
        invitation_method_google="Google or a password",
        recovery=(
            "We received a request to create or reset your password. "
            "Choose a password using this link:"
        ),
        invitation_lifetime="72 hours",
        recovery_lifetime="1 hour",
        single_use="This link can only be used once and expires in {lifetime}.",
        unexpected=(
            "If you were not expecting this message, ignore it or contact the administrator."
        ),
        password_notice="We will never ask you to send your password by email.",
        documents="Documents",
        document_version=" (version {number})",
        months=(
            "January", "February", "March", "April", "May", "June", "July", "August",
            "September", "October", "November", "December",
        ),
        month_year="{month} {year}",
        statement_missing_title="Missing statement: {month}",
        statement_missing_body="It has not been imported yet: import it in Finances > Import.",
        accounts_ready_title="The accounts of {month} are ready",
        accounts_ready_body="See the month's income and expenses in Finances > Overview.",
        action_statuses=(
            "Detected", "Requesting quotes", "Voting", "Approved", "Ordered / paid", "In progress",
            "Done", "Discarded",
        ),
        action_created_title="New action: {title}",
        action_created_body="Status: {status}",
        action_status_body="Now: {status}",
        comment_added="New comment by {author}",
        attachment_added="New PDF by {author}",
        comments_one="{count} new comment",
        comments_many="{count} new comments",
        attachments_one="{count} new PDF",
        attachments_many="{count} new PDFs",
        contributions="{items}",
        contributions_both="{comments} and {attachments}",
        weekdays=(
            "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
        ),
        event_day="{weekday} {day} {month}",
        event_day_year="{weekday} {day} {month} {year}",
        event_created="New event: {title}",
        event_changed="Event changed: {title}",
        event_cancelled="Event cancelled: {title}",
        reminder_today="Today: {title}",
        reminder_tomorrow="Tomorrow: {title}",
        reminder="Reminder: {title}",
    ),
    "es": Texts(
        administrator="Administrador técnico",
        community_name="Comunidad de vecinos",
        account_name="Cuenta de la comunidad",
        uncategorized="Sin categoría",
        no_merchant="Sin proveedor",
        manifest_description="Finanzas y actuaciones de la comunidad.",
        categories=(
            "Cuotas ordinarias", "Derramas", "Agua", "Electricidad", "Limpieza",
            "Mantenimiento", "Reparaciones", "Administración", "Seguros",
            "Servicios profesionales", "Impuestos", "Comisiones bancarias", "Otros",
        ),
        tags=(
            "Recurrente", "Extraordinario", "Devolución", "Transferencia", "Recibo", "Revisión",
        ),
        invitation_subject="Tu invitación a Juntia",
        recovery_subject="Recuperar tu contraseña de Juntia",
        greeting="Hola, {name}:",
        invitation=(
            "Te han invitado a la comunidad {community}. "
            "Activa tu cuenta con {method} en este enlace:"
        ),
        invitation_method="una contraseña",
        invitation_method_google="Google o con una contraseña",
        recovery="Se ha solicitado crear o restablecer tu contraseña. Elige una en este enlace:",
        invitation_lifetime="72 horas",
        recovery_lifetime="1 hora",
        single_use="El enlace es de un solo uso y caduca en {lifetime}.",
        unexpected="Si no esperabas este mensaje, ignóralo o contacta con la administración.",
        password_notice="Nunca te pediremos que envíes tu contraseña por correo.",
        documents="Documentos",
        document_version=" (versión {number})",
        months=(
            "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
            "septiembre", "octubre", "noviembre", "diciembre",
        ),
        month_year="{month} de {year}",
        statement_missing_title="Falta el extracto de {month}",
        statement_missing_body="Aún no se ha importado: impórtalo en Gastos > Importar.",
        accounts_ready_title="Ya están las cuentas de {month}",
        accounts_ready_body="Consulta los ingresos y gastos del mes en Gastos > Resumen.",
        action_statuses=(
            "Detectado", "Pidiendo presupuestos", "En votación", "Aprobado", "Encargado / pagado",
            "En ejecución", "Hecho", "Descartado",
        ),
        action_created_title="Nueva actuación: {title}",
        action_created_body="Estado: {status}",
        action_status_body="Ahora: {status}",
        comment_added="Nuevo comentario de {author}",
        attachment_added="Nuevo PDF de {author}",
        comments_one="{count} comentario",
        comments_many="{count} comentarios",
        attachments_one="{count} PDF",
        attachments_many="{count} PDF",
        contributions="{items} nuevos",
        contributions_both="{comments} y {attachments} nuevos",
        weekdays=("lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"),
        event_day="{weekday} {day} de {month}",
        event_day_year="{weekday} {day} de {month} de {year}",
        event_created="Nuevo evento: {title}",
        event_changed="Evento cambiado: {title}",
        event_cancelled="Evento cancelado: {title}",
        reminder_today="Hoy: {title}",
        reminder_tomorrow="Mañana: {title}",
        reminder="Recordatorio: {title}",
    ),
}


def texts(language: Language) -> Texts:
    return TEXTS[language]


async def configured_language(request: Request) -> Language:
    return request.app.state.settings.app_language


ServerLanguage = Annotated[Language, Depends(configured_language)]


def author_name(kind: str | None, name: str | None, language: Language) -> str:
    # What the technical administrator of earlier releases wrote shows this fixed label, never
    # its login name; accounts, administrators included, write as residents with their names.
    return texts(language).administrator if kind == "administrator" else name or ""
