-- Let a resident attach a report to their account, without ever requiring one.
--
-- Reporting an emergency must never require signing in. Someone on a borrowed
-- phone, with a dead account, or who has forgotten a password must still be
-- able to send a report. reporter_user_id is nullable, intake accepts a
-- request with no credentials exactly as before, and nothing treats an
-- anonymous report as lesser.
--
-- What an account buys: an anonymous report is readable only from the device
-- that sent it, because the per-report secret lives in that browser and
-- nowhere else. Attaching a user id lets a resident open their own report from
-- anywhere, which for a follow-up days later is the difference between a
-- conversation and a dead end. It buys nothing else — the policy below is
-- equality against auth.uid() and nothing wider.

alter table public.emergency_incidents
  add column if not exists reporter_user_id uuid references auth.users(id) on delete set null;

comment on column public.emergency_incidents.reporter_user_id is
  'The signed-in account that submitted this report, when there was one. NULL is normal and carries no meaning beyond "sent without signing in" — reporting never requires an account. On delete set null: erasing an account must not erase the incident record, which may be operational history.';

create index if not exists emergency_incidents_reporter_idx
  on public.emergency_incidents(reporter_user_id, received_at desc)
  where reporter_user_id is not null;

-- --------------------------------------------------------------------------
-- a resident may read their own report, and nothing else
-- ----------------------------------------------------------------------------

drop policy if exists emergency_incidents_reporter_read on public.emergency_incidents;
create policy emergency_incidents_reporter_read
  on public.emergency_incidents for select to authenticated
using (reporter_user_id is not null and reporter_user_id = (select auth.uid()));

-- Their own public timeline, on the same terms the anonymous status endpoint
-- already applies: public messages only. An internal operational note is not
-- something a resident sees because they happened to sign in.
drop policy if exists emergency_messages_reporter_read on public.emergency_messages;
create policy emergency_messages_reporter_read
  on public.emergency_messages for select to authenticated
using (
  visibility = 'public'
  and exists (
    select 1 from public.emergency_incidents i
    where i.id = emergency_messages.incident_id
      and i.reporter_user_id is not null
      and i.reporter_user_id = (select auth.uid())
  )
);

-- A resident may add to their own report's public thread. sender_kind is
-- pinned to 'resident' and visibility to 'public' so signing in cannot be used
-- to post as an agency or to write an internal note.
drop policy if exists emergency_messages_reporter_write on public.emergency_messages;
create policy emergency_messages_reporter_write
  on public.emergency_messages for insert to authenticated
with check (
  sender_kind = 'resident'
  and visibility = 'public'
  and exists (
    select 1 from public.emergency_incidents i
    where i.id = emergency_messages.incident_id
      and i.reporter_user_id is not null
      and i.reporter_user_id = (select auth.uid())
      and i.status not in ('resolved','closed')
   )
);

-- -----------------------------------------------------------------------------
-- a responder cannot reattribute a report
-- -----------------------------------------------------------------------------
--
-- reporter_user_id joins the frozen set. Who filed a report is part of the
-- report, and on a record that may become evidence, being able to change the
-- name attached to it is the same class of problem as being able to change
-- what it says.

create or replace function public.emergency_freeze_resident_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_frozen text;
begin
  if auth.uid() is null or public.emergency_is_platform_admin() then
    return new;
  end if;

  v_frozen := case
    when new.client_report_id  is distinct from old.client_report_id  then 'client_report_id'
    when new.public_reference   is distinct from old.public_reference  then 'public_reference'
    when new.report_secret_hash is distinct from old.report_secret_hash then 'report_secret_hash'
    when new.reporter_user_id  is distinct from old.reporter_user_id  then 'reporter_user_id'
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