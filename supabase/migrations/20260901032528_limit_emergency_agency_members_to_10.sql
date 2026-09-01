-- Hard cap for emergency responder access.
-- Each agency may have at most 10 ACTIVE responder accounts at a time.
-- Inactive historical memberships do not count toward the cap.
--
-- This is enforced in the database rather than only in the onboarding UI so
-- direct writes and concurrent activation requests cannot bypass the limit.

create schema if not exists private;

create or replace function private.emergency_enforce_agency_member_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_count integer;
begin
  if new.active is true then
    -- Serialize activations per agency so concurrent requests cannot both pass
    -- the count check and create an 11th active responder.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('emergency_agency_members:' || new.agency, 0)
    );

    select count(*)
      into v_active_count
    from public.emergency_agency_members m
    where m.agency = new.agency
      and m.active = true
      and not (m.user_id = new.user_id and m.agency = new.agency);

    if v_active_count >= 10 then
      raise exception 'Maximum of 10 active responder accounts allowed for %.', upper(new.agency)
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.emergency_enforce_agency_member_limit() from public, anon, authenticated;

drop trigger if exists emergency_agency_member_limit_guard on public.emergency_agency_members;
create trigger emergency_agency_member_limit_guard
before insert or update of active, agency
on public.emergency_agency_members
for each row
execute function private.emergency_enforce_agency_member_limit();

comment on function private.emergency_enforce_agency_member_limit() is
  'Hard guardrail: each emergency agency may have at most 10 active responder accounts. Uses a per-agency transaction advisory lock so concurrent activations cannot exceed the cap.';
