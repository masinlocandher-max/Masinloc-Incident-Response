-- Harden responder write privileges.
-- Agency users may operate an incident, but may never rewrite resident evidence,
-- GPS, identity, routing identity, public reference, or report authorization data.

revoke update on table public.emergency_incidents from authenticated;
grant update (status, priority, assigned_unit, assigned_user_id)
  on table public.emergency_incidents to authenticated;

-- Platform admins need CRUD privileges to activate/deactivate explicit agency
-- memberships. RLS still limits these writes to emergency_is_platform_admin().
grant insert, update, delete on table public.emergency_agency_members to authenticated;

create or replace function public.emergency_validate_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if new.assigned_user_id is distinct from old.assigned_user_id
     and new.assigned_user_id is not null
     and not exists (
       select 1
       from public.emergency_agency_members m
       join public.emergency_incident_agencies ia
         on ia.incident_id = new.id
        and ia.agency = m.agency
       where m.user_id = new.assigned_user_id
         and m.active = true
     ) then
    raise exception 'Assigned responder is not an active member of an agency linked to this incident'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists emergency_incident_validate_assignment on public.emergency_incidents;
create trigger emergency_incident_validate_assignment
before update of assigned_user_id on public.emergency_incidents
for each row execute function public.emergency_validate_assignment();

comment on function public.emergency_validate_assignment() is
  'Prevents assignment to an arbitrary authenticated account; assigned responders must belong to PNP/MDRRMO already linked to the incident.';
