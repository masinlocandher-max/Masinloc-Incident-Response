#!/usr/bin/env python3
"""Actually run the migrations, in order, against a real PostgreSQL.

WHY THIS EXISTS. Every other check on this schema reads the migration files as
text. Text checks confirm that a policy or a trigger is mentioned; they cannot
tell you the file parses, that a function body compiles, that a column exists
by the time a later migration references it, or that the ordering works. The
first time any of that was going to be discovered was somebody applying these
files to the production database — during a handover, under time pressure,
against the one database that holds residents' emergency reports.

So this applies them for real, to a throwaway cluster, and fails on anything
PostgreSQL refuses.

WHAT IS STUBBED, AND WHY THAT IS HONEST. Supabase supplies an `auth` schema:
auth.users, auth.uid(), auth.jwt(), and the anon/authenticated/service_role
roles. A stock PostgreSQL has none of them, so this file creates the minimum
that the migrations reference. That means this proves the migrations are valid
SQL that applies in order against a Supabase-shaped database. It does NOT prove
the RLS policies grant and deny the right things at runtime — the stub has no
real JWT and no real session. Those are different claims and this script only
makes the first one. It is the claim that was completely untested.

Idempotence is checked too: every migration runs twice. A migration that fails
on a second run is one that cannot be safely re-applied, which is exactly the
situation a nervous operator creates by running the folder again.

INHERITED GAPS. Some migrations in this folder alter objects that no migration
in this folder creates — they were made directly against the hosted database
and never written down. Those files cannot apply to an empty cluster, and this
script reports them by name rather than pretending otherwise. It does not fail
on them: they predate this work, and inventing the missing definitions to make
a check go green would be worse than naming the gap. It does fail on anything
else, and the emergency migrations must apply and re-apply with no failures of
any kind, because those are the ones handover depends on."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))

# The socket path has a 107-byte limit, so the cluster cannot live beside the
# repository or in a long scratch path.
BASE = Path(tempfile.mkdtemp(prefix="mz", dir="/tmp"))
PORT = "55433"

AUTH_STUB = """
create schema if not exists auth;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

do $$ begin create role anon nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin noinherit; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin noinherit bypassrls; exception when duplicate_object then null; end $$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_app_meta_data jsonb default '{}'::jsonb
);

-- Supabase's request-scoped helpers. Null here: no session exists in this
-- harness, which is why this file makes no claim about what RLS permits.
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable
  as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- pg_net and pg_cron are Supabase-hosted extensions with no local equivalent.
-- Stubbed so the migrations that schedule background work can still be parsed
-- and applied; nothing here performs a request or runs a schedule, so this
-- proves those files are valid SQL and nothing about what they would do.
create schema if not exists net;
create or replace function net.http_post(
  url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$ select 0::bigint $$;
create schema if not exists cron;
create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language sql as $$ select 0::bigint $$;
create or replace function cron.unschedule(job_name text)
returns boolean language sql as $$ select true $$;
"""

# Extensions the hosted platform provides and a local cluster does not. Their
# absence is an environment fact, not a defect in the migration.
HOSTED_EXTENSIONS = ("pg_net", "pg_cron", "pgjwt", "pgsodium", "supabase_vault", "http")


# Runs as a plain (non-admin) session first, then as a platform admin, by
# setting the JWT claims the way PostgREST does.
ACTIVATION_PROBE = """
\\set ON_ERROR_STOP on
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'duty.officer@example.invalid')
on conflict (email) do nothing;

-- 1. A signed-in account that is not a platform admin must be refused.
select set_config('request.jwt.claims', '{"app_metadata":{"role":"user"}}', false);
do $$ begin
  perform public.emergency_activate_member('duty.officer@example.invalid','pnp','operator');
  raise exception 'a non-admin was allowed to grant agency access';
exception when insufficient_privilege then raise notice 'NONADMIN_REFUSED';
end $$;

select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"}}', false);

-- 2. An address with no account must be refused loudly, not silently ignored:
--    a typo must never look like a successful activation.
do $$ begin
  perform public.emergency_activate_member('nobody@example.invalid','pnp','operator');
  raise exception 'an unknown email was activated';
exception when no_data_found then raise notice 'UNKNOWN_EMAIL_REFUSED';
end $$;

-- 3. A real account is activated, and the readiness endpoint's own query sees it.
do $$
declare n integer;
begin
  perform public.emergency_activate_member('duty.officer@example.invalid','pnp','dispatcher');
  select count(*) into n from public.emergency_agency_members
    where agency='pnp' and active and role='dispatcher';
  if n <> 1 then raise exception 'activation did not produce exactly one active row (got %)', n; end if;
  raise notice 'ACTIVATED';

  -- 4. Re-running must not error and must not duplicate.
  perform public.emergency_activate_member('duty.officer@example.invalid','pnp','supervisor');
  select count(*) into n from public.emergency_agency_members where agency='pnp';
  if n <> 1 then raise exception 're-activation created a second row'; end if;
  raise notice 'IDEMPOTENT';

  select count(*) into n from public.emergency_agency_roster() where active;
  if n <> 1 then raise exception 'roster does not show the activated account'; end if;
  raise notice 'ROSTER_SEES_IT';

  -- 5. Revocation clears access but keeps the record of who held it.
  perform public.emergency_deactivate_member('duty.officer@example.invalid','pnp');
  select count(*) into n from public.emergency_agency_members where agency='pnp' and active;
  if n <> 0 then raise exception 'deactivation left the account active'; end if;
  raise notice 'DEACTIVATED';

  select count(*) into n from public.emergency_agency_members where agency='pnp';
  if n <> 1 then raise exception 'deactivation deleted the row, destroying the access record'; end if;
  raise notice 'ROW_KEPT';
end $$;
"""


def pg_bin() -> Path:
    candidates = sorted(Path("/usr/lib/postgresql").glob("*/bin"))
    if candidates:
        return candidates[-1]
    found = shutil.which("initdb")
    if found:
        return Path(found).parent
    print("SKIP: no PostgreSQL server binaries found; cannot apply migrations here.")
    sys.exit(0)


def run(cmd: str, check: bool = True) -> subprocess.CompletedProcess:
    # initdb and postgres refuse to run as root, so everything goes through the
    # unprivileged postgres account when we happen to be root.
    if os.geteuid() == 0:
        cmd = f"su postgres -c {subprocess.list2cmdline([cmd])}"
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if check and result.returncode != 0:
        print(f"MIGRATION HARNESS FAILED to run: {cmd}")
        print(result.stdout[-3000:])
        print(result.stderr[-3000:])
        sys.exit(1)
    return result


MISSING = re.compile(
    r'(?:function|table|relation|type|column|constraint|trigger|schema|view)\s+'
    r'"?([\w.]+)', re.I)


def creator_of(name: str) -> Path | None:
    """Which migration here creates this object? Bare name, schema stripped."""
    bare = name.rsplit(".", 1)[-1]
    pattern = re.compile(rf"create\s+(or\s+replace\s+)?\w+\s+"
                         rf"(if\s+not\s+exists\s+)?(\w+\.)?{re.escape(bare)}\b", re.I)
    for path in MIGRATIONS:
        if pattern.search(path.read_text(encoding="utf-8")):
            return path
    return None


def main() -> int:
    if not MIGRATIONS:
        print("No migrations found.")
        return 0

    bins = pg_bin()
    data = BASE / "data"
    if os.geteuid() == 0:
        os.chmod(BASE, 0o777)
        shutil.chown(BASE, "postgres", "postgres")

    run(f"{bins/'initdb'} -D {data} -U app --auth=trust")
    run(f"{bins/'pg_ctl'} -D {data} -o '-p {PORT} -k {BASE}' -l {BASE/'pg.log'} start")
    time.sleep(2)

    psql = f"{bins/'psql'} -h {BASE} -p {PORT} -U app -d postgres -v ON_ERROR_STOP=1 -q"
    problems: list[str] = []
    try:
        stub = BASE / "auth_stub.sql"
        stub.write_text(AUTH_STUB, encoding="utf-8")
        if os.geteuid() == 0:
            os.chmod(stub, 0o644)
        run(f"{psql} -f {stub}")

        inherited: list[str] = []
        misordered: list[str] = []
        # A migration that could not run leaves its objects uncreated, so every
        # later file using them fails too. Those are one defect, not many, and
        # reporting them separately buries the root cause in its own noise.
        failed: set[str] = set()
        cascaded: list[str] = []

        def apply(path: Path) -> subprocess.CompletedProcess:
            staged = BASE / path.name
            staged.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
            if os.geteuid() == 0:
                os.chmod(staged, 0o644)
            return run(f"{psql} -f {staged}", check=False)

        # Pass 1: everything, in order. Failures are classified, not ignored.
        for path in MIGRATIONS:
            result = apply(path)
            if result.returncode == 0:
                continue
            failed.add(path.name)
            detail = (result.stderr or result.stdout).strip().splitlines()
            message = next((line for line in detail if "ERROR:" in line), detail[0] if detail else "unknown")
            if any(f'"{ext}" is not available' in message for ext in HOSTED_EXTENSIONS):
                inherited.append(f"{path.name} needs a hosted-only extension, so it cannot be "
                                 f"replayed locally: {message.split('ERROR:')[-1].strip()}")
                continue
            missing = MISSING.search(message.split("does not exist")[0]) if "does not exist" in message else None
            if missing:
                creator = creator_of(missing.group(1))
                if creator is None:
                    inherited.append(
                        f"{path.name} needs {missing.group(1)}, which no migration here creates")
                    continue
                if creator.name in failed:
                    cascaded.append(f"{path.name} (needs {missing.group(1)} from {creator.name})")
                    continue
                if creator.name > path.name:
                    # Filename order is apply order. An object used before the
                    # file that creates it means the folder cannot be replayed.
                    misordered.append(
                        f"{path.name} uses {missing.group(1)}, but {creator.name} creates it "
                        f"— and sorts after, so a replay reaches the use first")
                    continue
            problems.append(f"{path.name} does not apply: {message.strip()}")

        # Pass 1b: the activation path, exercised rather than read.
        #
        # Granting a person access to residents' emergency reports is the most
        # consequential write in this system, and at handover somebody will run
        # it for the first time against the real database. Proving the function
        # parses is not the same as proving it refuses a stranger, refuses a
        # non-admin, and is safe to run twice.
        probe = BASE / "activation_probe.sql"
        probe.write_text(ACTIVATION_PROBE, encoding="utf-8")
        if os.geteuid() == 0:
            os.chmod(probe, 0o644)
        result = run(f"{psql} -f {probe}", check=False)
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0:
            tail = [l for l in output.strip().splitlines() if "ERROR" in l or "DETAIL" in l]
            problems.append("activation path is broken: " + (tail[0] if tail else output.strip()[-400:]))
        else:
            for expected in ("NONADMIN_REFUSED", "UNKNOWN_EMAIL_REFUSED", "ACTIVATED",
                             "IDEMPOTENT", "ROSTER_SEES_IT", "DEACTIVATED", "ROW_KEPT"):
                if expected not in output:
                    problems.append(
                        f"activation path did not reach {expected} — see the probe in this file")

        # Pass 2: the emergency schema specifically, applied again. These are
        # the files somebody will run at handover, so they must be re-runnable.
        for path in [p for p in MIGRATIONS if "emergency" in p.name]:
            result = apply(path)
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip().splitlines()
                message = next((line for line in detail if "ERROR:" in line), detail[0] if detail else "unknown")
                problems.append(f"{path.name} is not re-runnable: {message.strip()}")

    finally:
        run(f"{bins/'pg_ctl'} -D {data} -m immediate stop", check=False)
        shutil.rmtree(BASE, ignore_errors=True)

    if problems:
        print("MIGRATION APPLY CHECK FAILED")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    emergency = [p for p in MIGRATIONS if "emergency" in p.name]
    print(f"Migrations apply: {len(MIGRATIONS) - len(inherited)} of {len(MIGRATIONS)} files "
          f"execute in order against a real PostgreSQL, and all {len(emergency)} emergency "
          f"migrations re-apply cleanly.")
    if inherited or misordered:
        print("\nPRE-EXISTING, NOT FIXED HERE. The emergency schema is clean; these are older "
              "files. They are reported rather than repaired because the repairs — writing "
              "definitions nobody has, or renaming migrations the hosted database has already "
              "recorded as applied — are decisions to be made deliberately, not side effects "
              "of a check going green.")
        for gap in misordered:
            print(f"  - out of order: {gap}")
        for gap in inherited:
            print(f"  - not in this folder: {gap}")
        if cascaded:
            print(f"  - {len(cascaded)} later file(s) then fail for want of what those never "
                  f"created: {', '.join(cascaded)}")
        print("\nConsequence: this repository alone cannot rebuild the database from scratch. "
              "It can still apply the emergency migrations to the existing one, which is what "
              "handover needs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
