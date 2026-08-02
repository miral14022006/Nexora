#!/usr/bin/env python3
"""
Validates render.yaml against the key invariants of Render's Blueprint spec
(https://render.com/docs/blueprint-spec).

Structural checks only - it does not replace `render blueprints validate`
(Render CLI), but catches the mistakes that commonly break a Blueprint sync:
  - free plan on private services / workers / cron jobs
  - healthCheckPath on non-web services
  - keyvalue instances without the required ipAllowList
  - dangling fromService / fromDatabase / fromGroup references
  - missing Dockerfiles or build contexts
  - no PORT on docker web services

Usage: python3 scripts/validate_render.py [path/to/render.yaml]
Exit code 0 = OK, 1 = problems found.
Requires PyYAML (preinstalled on GitHub Actions ubuntu runners).
"""
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML is required: pip install pyyaml", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
BLUEPRINT = Path(sys.argv[1] if len(sys.argv) > 1 else REPO_ROOT / "render.yaml")

FREE_FORBIDDEN = {"pserv", "worker", "cron"}
SERVICE_TYPES = {"web", "pserv", "worker", "cron", "keyvalue"}
FROM_SERVICE_PROPS = {"host", "port", "hostport", "connectionString"}

problems: list[str] = []
infos: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def ok(msg: str) -> None:
    infos.append(msg)


if not BLUEPRINT.exists():
    print(f"FAIL: blueprint not found: {BLUEPRINT}", file=sys.stderr)
    sys.exit(1)

doc = yaml.safe_load(BLUEPRINT.read_text())
if not isinstance(doc, dict):
    print("FAIL: render.yaml must contain a mapping at the root", file=sys.stderr)
    sys.exit(1)

services = doc.get("services") or []
databases = doc.get("databases") or []
groups = doc.get("envVarGroups") or []
projects = doc.get("projects") or []

# --- databases ---------------------------------------------------------------
db_names = {db.get("name") for db in databases}
for db in databases:
    if not db.get("name"):
        fail(f"database without name: {db}")

# --- env var groups ----------------------------------------------------------
group_names = set()
for g in groups:
    if not g.get("name"):
        fail("envVarGroup without name")
    else:
        group_names.add(g["name"])
    for ev in g.get("envVars", []):
        if not ev.get("key"):
            fail(f"group {g.get('name')}: envVar without key")

# --- services ----------------------------------------------------------------
service_names = {s.get("name") for s in services}
for svc in services:
    name = svc.get("name") or "?"
    stype = svc.get("type") or "?"
    runtime = svc.get("runtime") or "?"

    if not svc.get("name"):
        fail(f"service without name: {str(svc)[:120]}")
    if stype not in SERVICE_TYPES:
        fail(f"{name}: invalid type {stype!r}")
    if stype != "keyvalue" and not runtime:
        fail(f"{name}: missing runtime")

    # free plan is not available for private services / workers / cron
    if svc.get("plan") == "free" and stype in FREE_FORBIDDEN:
        fail(f"{name}: plan 'free' is not valid for {stype} services")

    # healthCheckPath is web-only
    if svc.get("healthCheckPath") and stype != "web":
        fail(f"{name}: healthCheckPath is only valid on web services")

    # keyvalue instances REQUIRE ipAllowList
    if stype == "keyvalue" and "ipAllowList" not in svc:
        fail(f"{name}: keyvalue requires an ipAllowList (use [] for internal-only)")

    # docker services: Dockerfile + context must exist
    if runtime == "docker":
        df = svc.get("dockerfilePath")
        ctx = svc.get("dockerContext")
        if not df:
            fail(f"{name}: docker service requires dockerfilePath")
        elif not (REPO_ROOT / df.lstrip("./")).exists():
            fail(f"{name}: Dockerfile not found at {df}")
        else:
            ok(f"{name}: Dockerfile {df} exists")
        if not ctx:
            fail(f"{name}: docker service requires dockerContext")
        elif not (REPO_ROOT / ctx.lstrip("./")).exists():
            fail(f"{name}: dockerContext not found at {ctx}")
        if stype == "web" and not any(e.get("key") == "PORT" for e in svc.get("envVars", [])):
            fail(f"{name}: web service without PORT env var")

    # env var references must resolve
    for ev in svc.get("envVars", []):
        ref = ev.get("fromService")
        if ref:
            if ref.get("name") not in service_names:
                fail(f"{name}: fromService references unknown service {ref.get('name')!r}")
            if ref.get("type") not in {"web", "pserv", "keyvalue"}:
                fail(f"{name}: fromService type must be web|pserv|keyvalue, got {ref.get('type')!r}")
            prop = ref.get("property")
            if prop and prop not in FROM_SERVICE_PROPS:
                fail(f"{name}: unknown fromService property {prop!r}")
            if ref.get("property") is None and not ref.get("envVarKey"):
                fail(f"{name}: fromService needs a property or envVarKey")
        if ev.get("fromDatabase") and ev["fromDatabase"].get("name") not in db_names:
            fail(f"{name}: fromDatabase references unknown database {ev['fromDatabase'].get('name')!r}")
        if ev.get("fromGroup") and ev["fromGroup"] not in group_names:
            fail(f"{name}: fromGroup references unknown group {ev['fromGroup']!r}")

# --- summary ------------------------------------------------------------------
print(f"Blueprint: {BLUEPRINT}")
print(
    f"  services: {len(services)} "
    f"({', '.join(s.get('name') or s.get('type') for s in services)})"
)
print(f"  databases: {len(databases)}")
print(f"  env var groups: {len(groups)}")
if projects:
    print(f"  projects: {len(projects)}")
print()
if problems:
    print(f"FAIL - {len(problems)} problem(s):")
    for p in problems:
        print(f"  x {p}")
    sys.exit(1)
print("PASS - no structural problems found.")
