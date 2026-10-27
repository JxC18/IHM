import os

os.environ.setdefault("RM_ENV", "test")
os.environ.setdefault("RM_COOKIE_SECURE", "false")
os.environ.setdefault("RM_BIGQUERY_MODE", "fake")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app import models  # noqa: E402, F401
from app.db import Base, get_db  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services.bigquery import FakeBigQueryGateway, get_bigquery  # noqa: E402
from app.services.registry import get_registry  # noqa: E402


class RecordingRegistry:
    def __init__(self):
        self.upserts = []

    def upsert(self, v, owner_matricule):
        self.upserts.append((v.rule_id, v.version, v.status))


@pytest.fixture
def bq():
    return FakeBigQueryGateway()


@pytest.fixture
def registry():
    return RecordingRegistry()


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def client(bq, registry, session_factory):
    def db():
        with session_factory() as s:
            yield s

    app = create_app()
    app.dependency_overrides[get_db] = db
    app.dependency_overrides[get_bigquery] = lambda: bq
    app.dependency_overrides[get_registry] = lambda: registry
    with TestClient(app) as c:
        yield c


def login(client, matricule="104233", first="Camille", last="Martin"):
    r = client.post("/session", json={"matricule": matricule})
    assert r.status_code == 200, r.text
    if r.json()["needsProfile"]:
        r = client.post("/me/profile", json={"firstName": first, "lastName": last})
        assert r.status_code == 200, r.text
    return client
