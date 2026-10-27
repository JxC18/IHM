import uuid

from sqlalchemy.orm import Session

from app.auth import full_name
from app.clock import now
from app.models import AuditEvent, RuleVersion, User


def record(
    db: Session, user: User, action: str, version: RuleVersion | None = None, details: str | None = None
) -> None:
    """Ajoute un événement au journal (jamais de mise à jour ni de suppression)."""
    db.add(
        AuditEvent(
            id=str(uuid.uuid4()),
            at=now(),
            matricule=user.matricule,
            user_name=full_name(user),
            action=action,
            rule_id=version.rule_id if version else None,
            rule_name=version.name if version else None,
            version=version.version if version else None,
            details=details,
        )
    )
