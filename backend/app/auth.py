"""Identification V1 (PRD F8) : session par matricule, profil, utilisateurs.

Point UNIQUE de résolution de l'identité (PRD §5.4, règle 2).

Aucun autre module ne lit le cookie ou la table `sessions`. La bascule SSO
consistera à réécrire `get_current_user` pour lire le matricule dans le jeton OIDC.

Rappel : le matricule n'est PAS un facteur d'authentification. Le contrôle
d'accès réel est la restriction réseau (IAP / ingress interne).
"""

import hashlib
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import ApiError, Settings, as_utc, get_settings, now
from app.database import User, UserSession, get_db, record_audit
from app.schemas import LoginIn, LoginOut, ProfileIn, UserOut

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


# --------------------------------------------------------------------------- routes

router = APIRouter(tags=["identification"])


@router.post("/session", response_model=LoginOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    # Seul contrôle : le format. Ce n'est pas une authentification (PRD F8).
    if not MATRICULE_RE.match(body.matricule):
        raise ApiError(422, "Le matricule doit comporter exactement 6 chiffres.")
    user = db.get(User, body.matricule)
    open_session(db, response, body.matricule, pending_profile=user is None)
    if user:
        record_audit(db, user, "LOGIN")
    db.commit()
    return LoginOut(user=UserOut.model_validate(user) if user else None, needs_profile=user is None)


@router.post("/me/profile", response_model=UserOut)
def complete_profile(
    body: ProfileIn, rec: UserSession | None = Depends(get_session_record), db: Session = Depends(get_db)
):
    if rec is None or not rec.pending_profile:
        raise ApiError(400, "Aucune première connexion en cours.")
    user = db.get(User, rec.matricule) or User(
        matricule=rec.matricule,
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        created_at=now(),
    )
    db.add(user)
    rec.pending_profile = False
    rec.last_seen = now()
    record_audit(db, user, "LOGIN", details="Première connexion")
    db.commit()
    return user


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.patch("/me", response_model=UserOut)
def update_me(body: ProfileIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.first_name, user.last_name = body.first_name.strip(), body.last_name.strip()
    record_audit(db, user, "PROFILE_UPDATE")
    db.commit()
    return user


@router.delete("/session", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    close_session(db, request, response)
    db.commit()
    response.status_code = 204
    return response


@router.get("/users", response_model=list[UserOut])
def users(_: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.last_name)).all()
