"""Identification V1 (PRD F8) — point UNIQUE de résolution de l'identité (PRD §5.4, règle 2).

Aucun autre module ne lit le cookie ou la table `sessions`. La bascule SSO
consistera à réécrire `get_current_user` pour lire le matricule dans le jeton OIDC.

Rappel : le matricule n'est PAS un facteur d'authentification. Le contrôle
d'accès réel est la restriction réseau (IAP / ingress interne).
"""

import hashlib
import re
import secrets
from datetime import timedelta

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.clock import as_utc, now
from app.config import Settings, get_settings
from app.db import get_db
from app.errors import ApiError
from app.models import User, UserSession

MATRICULE_RE = re.compile(r"^\d{6}$")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def open_session(db: Session, response: Response, matricule: str, pending_profile: bool) -> None:
    settings = get_settings()
    token = secrets.token_urlsafe(32)
    db.add(
        UserSession(
            token_hash=_hash(token), matricule=matricule, pending_profile=pending_profile, last_seen=now()
        )
    )
    response.set_cookie(
        settings.session_cookie,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def close_session(db: Session, request: Request, response: Response) -> None:
    settings = get_settings()
    token = request.cookies.get(settings.session_cookie)
    if token:
        db.query(UserSession).filter_by(token_hash=_hash(token)).delete()
    response.delete_cookie(settings.session_cookie, path="/")


def get_session_record(
    request: Request, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)
) -> UserSession | None:
    token = request.cookies.get(settings.session_cookie)
    if not token:
        return None
    rec = db.get(UserSession, _hash(token))
    if rec is None:
        return None
    if now() - as_utc(rec.last_seen) > timedelta(hours=settings.session_ttl_hours):
        db.delete(rec)
        db.commit()
        return None
    return rec


def get_current_user(
    rec: UserSession | None = Depends(get_session_record), db: Session = Depends(get_db)
) -> User:
    if rec is None or rec.pending_profile:
        raise ApiError(401, "Session expirée ou absente.")
    user = db.get(User, rec.matricule)
    if user is None:
        raise ApiError(401, "Utilisateur inconnu.")
    rec.last_seen = now()  # session glissante
    db.commit()
    return user


def full_name(u: User) -> str:
    return f"{u.first_name} {u.last_name}"
