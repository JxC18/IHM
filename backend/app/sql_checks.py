"""Contrôles de la requête (PRD F2). Miroir de frontend/src/lib/sql.ts.

Les contraintes structurelles (SELECT unique, colonne order_id) s'appuient sur
les métadonnées du dry-run BigQuery, pas sur le texte : voir `query.py`. Ici,
uniquement ce que BigQuery ne dit pas : cohérence des paramètres, @run_date,
dates en dur.
"""

import re

from app.schemas import RuleParameter, SqlIssue

RUN_DATE_PARAM = "run_date"

_PARAM_RE = re.compile(r"(^|[^@\w])@([A-Za-z_]\w*)")
_NAME_RE = re.compile(r"^[A-Za-z_]\w*$")
_DATE_RE = re.compile(r"(?:\b(?:DATE|TIMESTAMP)\s*)?'\d{4}-\d{2}-\d{2}[^']*'", re.IGNORECASE)


def mask_sql(sql: str, keep_strings: bool = False) -> str:
    """Remplace commentaires (et littéraux) par des espaces, positions conservées."""
    out: list[str] = []
    i, n = 0, len(sql)

    def blank(s: str) -> str:
        return re.sub(r"[^\n]", " ", s)

    while i < n:
        c = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""
        if (c == "-" and nxt == "-") or c == "#":
            end = sql.find("\n", i)
            stop = n if end == -1 else end
            out.append(blank(sql[i:stop]))
            i = stop
        elif c == "/" and nxt == "*":
            end = sql.find("*/", i + 2)
            stop = n if end == -1 else end + 2
            out.append(blank(sql[i:stop]))
            i = stop
        elif c in "'\"`":
            j = i + 1
            while j < n and sql[j] != c:
                j += 2 if sql[j] == "\\" else 1
            stop = min(j + 1, n)
            chunk = sql[i:stop]
            if c == "`" or keep_strings:
                out.append(chunk)
            else:
                out.append(c + blank(chunk[1:-1]) + (c if stop > i + 1 else ""))
            i = stop
        else:
            out.append(c)
            i += 1
    return "".join(out)


def offset_to_line_col(sql: str, offset: int) -> tuple[int, int]:
    before = sql[:offset]
    return before.count("\n") + 1, offset - before.rfind("\n")


def find_params(sql: str) -> list[tuple[str, int]]:
    return [(m.group(2), m.start() + len(m.group(1))) for m in _PARAM_RE.finditer(mask_sql(sql))]


def check_params(sql: str, declared: list[RuleParameter]) -> list[SqlIssue]:
    issues: list[SqlIssue] = []
    used = find_params(sql)
    used_names = {n for n, _ in used}
    declared_names = {p.name for p in declared}
    reported: set[str] = set()

    for name, off in used:
        if name == RUN_DATE_PARAM or name in declared_names or name in reported:
            continue
        reported.add(name)
        line, col = offset_to_line_col(sql, off)
        issues.append(
            SqlIssue(
                severity="error",
                code="PARAM_UNDECLARED",
                message=f"Le paramètre @{name} est utilisé mais n'est pas déclaré.",
                line=line,
                column=col,
                length=len(name) + 1,
            )
        )
    for p in declared:
        if not p.name:
            continue
        if p.name == RUN_DATE_PARAM:
            issues.append(
                SqlIssue(
                    severity="error",
                    code="PARAM_RESERVED",
                    message=f"@{RUN_DATE_PARAM} est réservé et fourni par Airflow : ne le déclarez pas.",
                )
            )
        elif p.name not in used_names:
            issues.append(
                SqlIssue(
                    severity="warning",
                    code="PARAM_UNUSED",
                    message=f"Le paramètre @{p.name} est déclaré mais absent de la requête.",
                )
            )
        if not _NAME_RE.match(p.name):
            issues.append(
                SqlIssue(
                    severity="error", code="PARAM_NAME", message=f"Nom de paramètre invalide : « {p.name} »."
                )
            )
    names = [p.name for p in declared if p.name]
    for dup in sorted({n for n in names if names.count(n) > 1}):
        issues.append(
            SqlIssue(
                severity="error",
                code="PARAM_DUPLICATE",
                message=f"Le paramètre @{dup} est déclaré plusieurs fois.",
            )
        )
    if RUN_DATE_PARAM not in used_names:
        issues.append(
            SqlIssue(
                severity="error",
                code="RUN_DATE_MISSING",
                message=f"La requête doit utiliser @{RUN_DATE_PARAM} pour sa fenêtre d'exécution.",
            )
        )
    return issues


def check_hardcoded_dates(sql: str) -> list[SqlIssue]:
    masked = mask_sql(sql, keep_strings=True)
    issues = []
    for m in _DATE_RE.finditer(masked):
        line, col = offset_to_line_col(sql, m.start())
        issues.append(
            SqlIssue(
                severity="error",
                code="HARDCODED_DATE",
                message=f"Date « en dur » ({m.group(0)}) : utilisez @run_date pour la fenêtre d'exécution.",
                line=line,
                column=col,
                length=len(m.group(0)),
            )
        )
    return issues


def query_hash(sql: str, params: list[RuleParameter]) -> str:
    """Empreinte requête + paramètres, identique à `queryHash` du front (FNV-1a 32 bits sur UTF-16)."""
    s = re.sub(r"\s+", " ", sql.strip()) + "|" + ",".join(f"{p.name}:{p.type}:{p.default}" for p in params)
    h = 0x811C9DC5
    data = s.encode("utf-16-le")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"
