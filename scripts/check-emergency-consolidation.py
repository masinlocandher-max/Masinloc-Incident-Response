#!/usr/bin/env python3
"""Keep the PNP/MDRRMO service one system.

Two implementations of this service were built in parallel: the canonical
emergency_* architecture, and a prototype assistance_* schema with its own
console pair and its own agency-membership table. The decision was to keep one.
This file is what stops the second from coming back — by a merge, a
cherry-pick, or somebody solving the same problem twice without knowing the
first solution exists.

WHAT IT ENFORCES.

  1. One schema. Nothing shipped references assistance_* tables.
  2. One console per agency. No second PNP or MDRRMO operator route.
  3. One membership model. Agency authorisation is asked of exactly one table.
  4. Assistance lives inside the canonical incident model as report_mode, not
     as a parallel system.
  5. Resident intent never becomes operational priority. A report arrives
     unassessed whatever mode it carries, and priority is a human judgement.
  6. Internal notes never reach the resident.
  7. A responder cannot rewrite the resident's own report.
  8. Offline-shell fixes can reach returning devices.
  9. Trigger-only functions cannot become public RPC endpoints.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
problems: list[str] = []

MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))
SQL = "\n".join(p.read_text(encoding="utf-8") for p in MIGRATIONS)
FUNCTION = ROOT / "supabase" / "functions" / "emergency-response" / "index.ts"
EDGE = FUNCTION.read_text(encoding="utf-8") if FUNCTION.is_file() else ""

SHIPPED = ([p for p in ROOT.glob("*.html")] + [p for p in ROOT.glob("*.js")]
           + [p for p in (ROOT / "emergency").glob("*") if p.suffix in {".html", ".js"}])

# --- 1. one schema --------------------------------------------------------

for path in SHIPPED + MIGRATIONS + ([FUNCTION] if FUNCTION.is_file() else []):
    text = path.read_text(encoding="utf-8")
    if re.search(r"\bassistance_(reports|messages|desks|desk_members|report_events)\b", text):
        problems.append(
            f"{path.relative_to(ROOT)} references an assistance_* table. The canonical "
            f"model is emergency_incidents with a report_mode of 'assistance' — there is "
            f"no second schema.")

# --- 2. one console per agency -------------------------------------------

CANONICAL = {"pnp": "emergency/pnp.html", "mdrrmo": "emergency/mdrrmo.html"}
for agency, canonical in CANONICAL.items():
    if not (ROOT / canonical).is_file():
        problems.append(f"the canonical {agency.upper()} console {canonical} is missing")
    # A responder console is any page that queries the incident tables. Finding
    # one outside emergency/ means a second operational generation exists.
    for page in ROOT.glob("*.html"):
        raw = page.read_text(encoding="utf-8")
        script_names = re.findall(r'src="([^"]+\.js)', raw)
        bodies = raw + "".join(
            (ROOT / name.split("?")[0]).read_text(encoding="utf-8")
            for name in script_names
            if (ROOT / name.split("?")[0]).is_file())
        if re.search(r"emergency_incidents|emergency_agency_members", bodies):
            problems.append(
                f"{page.name} is a second responder console for the incident model. "
                f"{canonical} is the only one.")
            break

# --- 3. one membership model ---------------------------------------------

member_tables = set(re.findall(r"\b(\w*(?:agency|desk)_members)\b", SQL))
if member_tables - {"emergency_agency_members"}:
    problems.append(
        f"more than one agency-membership table exists: {sorted(member_tables)}. "
        f"Authorisation is emergency_agency_members and nothing else.")

agency_js = ROOT / "emergency" / "agency.js"
if agency_js.is_file():
    used = set(re.findall(r"from\('(\w*_members)'\)", agency_js.read_text(encoding="utf-8")))
    if used - {"emergency_agency_members"}:
        problems.append(f"the consoles authorise against {sorted(used)}, not one model")

# --- 4. assistance is a mode on the canonical model ----------------------

if "report_mode" not in SQL:
    problems.append(
        "no report_mode column on the incident model — assistance must be a mode "
        "within the canonical incident, not a separate system")
if not re.search(r"report_mode[^;]*check[^;]*'assistance'", SQL, re.S):
    problems.append("report_mode does not constrain its values to emergency/assistance")
if "report_mode" not in EDGE:
    problems.append("the intake function does not carry report_mode")

# --- 5. intent is not priority -------------------------------------------

# The two must stay distinct columns with distinct owners. A mapping from mode
# to priority anywhere in intake would be an automated triage decision, which
# this system is explicitly not permitted to make.
if not re.search(r"emergency_intake_priority_guard", SQL):
    problems.append(
        "no intake guard forcing new incidents to 'unassessed'. Without it an intake "
        "path could encode 'assistance means low', which is an automated triage "
        "decision a human must make instead.")

for path in SHIPPED + ([FUNCTION] if FUNCTION.is_file() else []):
    text = path.read_text(encoding="utf-8")
    # A literal priority assigned in the same breath as a mode.
    if re.search(r"report_mode[^;\n]{0,80}priority\s*[:=]\s*['\"](critical|high|normal|low)",
                 text) or re.search(
                 r"priority\s*[:=]\s*['\"](critical|high|normal|low)[^;\n]{0,80}report_mode", text):
        problems.append(
            f"{path.relative_to(ROOT)} derives a priority from the report mode. The "
            f"resident says what they are sending; the agency decides how urgent it is.")

# --- 6. internal notes stay internal -------------------------------------

if EDGE:
    status_fn = re.search(r"async function status\(.*?\n(?=async function|\Z)", EDGE, re.S)
    block = status_fn.group(0) if status_fn else EDGE
    if 'emergency_messages' in block and '"visibility","public"' not in block.replace(" ", ""):
        problems.append(
            "the resident status endpoint does not restrict messages to visibility "
            "'public' — internal operational notes would reach the reporter")

# --- 7. the resident's report is theirs ----------------------------------

if "emergency_freeze_resident_fields" not in SQL:
    problems.append(
        "no trigger freezing resident-authored incident fields. RLS decides which "
        "incidents a responder may update, not which columns, so without this an "
        "authorised responder can rewrite the reporter's own description and GPS.")
else:
    frozen = re.search(r"emergency_freeze_resident_fields.*?\$\$;", SQL, re.S).group(0)
    for column in ("description", "latitude", "longitude", "report_mode",
                   "target_agency", "report_secret_hash", "public_reference"):
        if column not in frozen:
            problems.append(f"the resident-field freeze does not cover {column}")

# --- 8. a fix to the offline shell can actually reach a device -----------

# The service worker is cache-first for scripts. If its cache name does not move
# when the shell does, a corrected emergency.js is served from cache forever —
# on this page that means a fix to delivery logic that never arrives.
SW = ROOT / "emergency" / "sw.js"
INDEX = ROOT / "emergency" / "index.html"
if SW.is_file() and INDEX.is_file():
    sw = SW.read_text(encoding="utf-8")
    version = re.search(r"SHELL_VERSION\s*=\s*'([^']+)'", sw)
    stamp = re.search(r"emergency\.js\?v=([0-9-]+)", INDEX.read_text(encoding="utf-8"))
    if not version:
        problems.append("emergency/sw.js has no SHELL_VERSION, so its cache name cannot move with the shell")
    elif not stamp:
        problems.append("emergency/index.html does not stamp emergency.js")
    elif version.group(1) != stamp.group(1):
        problems.append(
            f"the service worker caches shell {version.group(1)} but the page loads "
            f"{stamp.group(1)} — returning devices would keep the old delivery logic")

# --- 9. trigger machinery is not a browser RPC ---------------------------

# PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default.
# Trigger functions do not need direct execution from anon/authenticated roles;
# leaving that grant in place exposes SECURITY DEFINER machinery through the
# Data API even though the intended path is only the attached trigger.
TRIGGER_FUNCTIONS = (
    "emergency_freeze_resident_fields",
    "emergency_intake_priority_guard",
    "emergency_log_incident_change",
    "emergency_touch_incident",
    "emergency_validate_assignment",
)
for function in TRIGGER_FUNCTIONS:
    revoke = re.search(
        rf"revoke\s+all\s+on\s+function\s+public\.{function}\(\)\s+"
        rf"from\s+public\s*,\s*anon\s*,\s*authenticated\s*;",
        SQL,
        re.I | re.S,
    )
    if not revoke:
        problems.append(
            f"{function}() is trigger-only but is not explicitly revoked from "
            "PUBLIC, anon and authenticated; it could become a browser-callable RPC")

if problems:
    print("EMERGENCY CONSOLIDATION CHECK FAILED")
    for problem in problems:
        print(f"  - {problem}")
    sys.exit(1)

print("Emergency consolidation: one incident schema, one membership model, one console "
      "per agency, assistance carried as report_mode, priority owned by the agency, "
      "internal notes internal, and the resident's own report immutable to responders.")
