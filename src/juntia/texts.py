"""Server-generated texts in the language configured by APP_LANGUAGE.

The web interface follows each browser's language; these texts cover what the server writes
itself: emails, first-run defaults, fallback labels and the administrator's author label.
"""

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request

from .config import Language
from .contracts import UserAuthOut


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
    ),
}


def texts(language: Language) -> Texts:
    return TEXTS[language]


async def configured_language(request: Request) -> Language:
    return request.app.state.settings.app_language


ServerLanguage = Annotated[Language, Depends(configured_language)]


def author_name(kind: str | None, name: str | None, language: Language) -> str:
    # Residents never see the administrator's login name, only this fixed label.
    return texts(language).administrator if kind == "administrator" else name or ""


def public_actor(identity: UserAuthOut, language: Language) -> UserAuthOut:
    """The session identity as stored in authorship snapshots."""
    return identity.model_copy(
        update={"name": author_name(identity.kind, identity.name, language)}
    )
