-- Consolidation: one incident model that carries both emergency and assistance
-- traffic, and a hard boundary around what a responder may rewrite.
--
-- WHY report_mode IS NOT priority. A resident saying "this is not an emergency"
-- is a statement of intent, not an operational judgement. PNP or MDRRMO may
-- read the same report and decide it needs urgent handling — a "non-emergency"
-- follow-up about a recurring threat can be exactly that. So intent and
-- priority are two columns with two owners:
--
--   report_mode  written once, at intake, by the resident. Never changed by a
--                responder. It says what the person thought they were sending.
--   priority     owned entirely by the agency, and 'unassessed' until a human
--                sets it. Nothing derives it from report_mode.
--
-- Collapsing these would mean an assistance report could never be escalated
-- without rewriting the resident's own words about what they sent, and an
-- emergency report could be silently downgraded by intake rather than by a
-- named officer.
--
-- This replaces the separate assistance_* schema that was prototyped on
-- another branch. There is one incident table, one membership model, one
-- message/timeline model and one audit trail; assistance is a mode within
-- them, not a parallel system.

-- --------------------------------------------------------------------------
-- report_mode
-- --------------------------------------------------------------------------

alter table public.emergency_incidents
  add column if not exists report_mode text not null default 'emergency';

do $$ begin
  alter table public.emergency_incidents
    add constraint emergency_incidents_report_mode_check
    check (report_mode in ('emergency','assistance'));
exception when duplicate_object then null; end $$;

comment on column public.emergency_incidents.report_mode is
  'What the resident said they were sending: emergency (immediate danger, rescue, active incident) or assistance (non-urgent concern, request or follow-up). Set once at intake and never rewritten by a responder. This is NOT priority — the agency owns priority and may escalate an assistance report.';

-- A console filters on (agency, mode, recency), so the index matches that.
create index if not exists emergency_incidents_agency_mode_idx
  on public.emergency_incidents(target_agency, report_mode, received_at desc);

-- 'low' completes the operational scale now that assistance traffic shares the
-- table. 'unassessed' stays the default: a priority means a human decided it.
do $$ begin
  alter table public.emergency_incidents drop constraint if exists emergency_incidents_priority_check;
  alter table public.emergency_incidents
    add constraint emergency_incidents_priority_check
    check (priority in ('unassessed','critical','high','normal','low'));
exception when undefined_table then null; end $$;

-- --------------------------------------------------------------------------
-- what a responder may never rewrite
-- --------------------------------------------------------------------------

-- The RLS update policy authorises WHICH incidents a responder may touch. It
-- says nothing about WHICH COLUMNS, so an authorised responder could rewrite
-- the resident's own account of what happened, their coordinates, their
-- contact details, or the reference and secret that let them read their report
-- back. On an incident record that may later be evidence, that is the most
-- consequential gap in the model.
--
-- These columns are the resident's, written once at intake. A correction from
-- the resident is a new message on the timeline; a responder's account of
-- events is an operational note. Neither is an edit to the original report.
create or replace function public.emergency_freeze_resident_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_frozen text;
begin
  -- Platform admins and the service role are exempt: intake itself writes
  -- these, and a genuine data-protection erasure has to be possible.
  if auth.uid() is null or public.emergency_is_platform_admin() then
    return new;
  end if;

  v_frozen := case
    when new.client_report_id  is distinct from old.client_report_id  then 'client_report_id'
    when new.public_reference  is distinct from old.public_reference  then 'public_reference'
    when new.report_secret_hash is distinct from old.report_secret_hash then 'report_secret_hash'
    when new.target_agency     is distinct from old.target_agency     then 'target_agency'
    when new.report_mode       is distinct from old.report_mode       then 'report_mode'
    when new.incident_type     is distinct from old.incident_type     then 'incident_type'
    when new.description       is distinct from old.description       then 'description'
    when new.latitude          is distinct from old.latitude          then 'latitude'
    when new.longitude         is distinct from old.longitude         then 'longitude'
    when new.accuracy_m        is distinct from old.accuracy_m        then 'accuracy_m'
    when new.received_at       is distinct from old.received_at       then 'received_at'
    else null
  end;

  if v_frozen is not null then
    raise exception
      'A responder cannot change %, which is the resident''s own report. Add a message or an operational note instead.',
      v_frozen
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists emergency_incidents_freeze_resident on public.emergency_incidents;
create trigger emergency_incidents_freeze_resident
  before update on public.emergency_incidents
  for each row execute function public.emergency_freeze_resident_fields();

-- --------------------------------------------------------------------------
-- intent must not become priority by itself
-- --------------------------------------------------------------------------

-- Belt for the braces above: nothing may set a priority at intake. A report
-- arrives 'unassessed' whatever mode it carries, so the first priority on any
-- incident is one a named officer chose. Without this an intake path could
-- quietly encode "assistance means low", which is the automated triage
-- decision this system is specifically not allowed to make.
create or replace function public.emergency_intake_priority_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.priority is distinct from 'unassessed' then
    raise exception
      'An incident is created unassessed. Priority is an agency judgement and cannot be set at intake.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists emergency_incidents_intake_priority on public.emergency_incidents;
create trigger emergency_incidents_intake_priority
  before insert on public.emergency_incidents
  for each row execute function public.emergency_intake_priority_guard();
