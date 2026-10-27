import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.errors import ApiError, api_error_handler
from app.routers import audit, performance, query, rules, session


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO, format='{"level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}'
    )

    # Le front appelle /api/... ; le préfixe est retiré par le proxy (Vite en local, Nginx en production).
    app = FastAPI(title="Rules Manager API", version="0.1.0")
    app.add_exception_handler(ApiError, api_error_handler)
    if settings.env == "local":
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    for r in (session.router, rules.router, query.router, performance.router, audit.router):
        app.include_router(r)

    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"status": "ok"}

    return app


app = create_app()
