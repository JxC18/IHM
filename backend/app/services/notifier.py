"""Notification de l'équipe data à la soumission (PRD F4). Canal à arbitrer (PRD Q6)."""

import json
import logging
import urllib.request

from app.config import get_settings
from app.models import RuleVersion

log = logging.getLogger(__name__)


def notify_submission(v: RuleVersion, by: str) -> None:
    payload = {"event": "RULE_SUBMITTED", "ruleId": v.rule_id, "version": v.version, "name": v.name, "by": by}
    url = get_settings().notify_webhook_url
    if not url:
        log.info("notification équipe data (pas de canal configuré) : %s", payload)
        return
    try:
        req = urllib.request.Request(url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).close()
    except OSError:
        # La soumission est enregistrée ; un échec de notification ne doit pas l'annuler.
        log.exception("échec de la notification équipe data")
