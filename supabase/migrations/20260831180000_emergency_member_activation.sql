-- Activating a real responder, without hand-written SQL at handover time.
--
-- Granting agency access is the single most consequential write in this
-- system: it lets a named person read residents' emergency reports, including
-- GPS coordinates, contact details and free-text descriptions of what is
-- happening to them. Until now the only way to do it was an INSERT typed by
-- hand into emergency_agency_members, which is exactly the operation you least
-- want performed from memory, at speed, by someone who has just been handed a
-- system.
--
-- These functions do not widen anything. Platform admins already hold insert,
-- update and delete on that table through RLS; this is the same authority with
-- the mistakes made harder:
--
--   * an unknown email is refused, rather than silently inserting nothing
--   * agency and role are validated against the same constraints as the table
--   * activation is idempotent — re-running it reactivates rather than erroring
--   * deactivation is a flag, never a delete, so the audit trail of who held
--     access and when is not destroyed by revoking it
--
-- WHAT THESE FUNCTIONS WILL NOT DO. They do not create auth users. An account
-- must already exist, made through Supabase's own admin flow by somebody who
-- verified the person is who they say they are. Identity is not a thing this
-- system should be inventing, and an activation helper that could conjure a
-- login would be a way to manufacture a responder.

create or replace function public.emergency_activate_member(
  p_email text,
  p_agency text,
  p_role text default 'operator',
  p_display_name text default null
)
-- The output columns are deliberately not named user_id/agency/role: those
-- would shadow the table's own columns inside the body, and PostgreSQL rejects
-- the ON CONFLICT target below as ambiguous when they do.
returns table (member_user_id uuid, member_agency text, member_role text, member_active boolean)
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if not public.emergency_is_platform_admin() then
    raise exception 'Only a platform administrator may activate agency access.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_agency not in ('pnp','mdrrmo') then
    raise exception 'Agency must be pnp or mdrrmo, not %.', p_agency
      using errcode = 'check_violation';
  end if;

  if p_role not in ('operator','dispatcher','supervisor') then
    raise exception 'Role must be operator, dispatcher or supervisor, not %.', p_role
      using errcode = 'check_violation';
  end if;

  -- The account must already exist. Refusing loudly here is the point: a
  -- typo'd address must not look like a successful activation, or a desk will
  -- be believed staffed when nobody can sign in.
  select u.id into v_user_id from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_user_id is null then
    raise exception
      'No account exists for %. Create the account first, then activate it — this function never creates logins.',
      p_email
      using errcode = 'no_data_found';
  end if;

  insert into public.emergency_agency_members as m (user_id, agency, role, display_name, active)
  values (v_user_id, p_agency, p_role, nullif(trim(coalesce(p_display_name,'')),''), true)
  on conflict (user_id, agency) do update
    set role = excluded.role,
        display_name = coalesce(excluded.display_name, m.display_name),
        active = true;

  return query
    select m.user_id, m.agency, m.role, m.active
    from public.emergency_agency_members m
    where m.user_id = v_user_id and m.agency = p_agency;
end;
$$;

-- Revoking access is a flag, not a delete. Who held access to residents'
-- emergency reports, and when, is a fact worth keeping after the access ends;
-- a DELETE would erase it. Nothing reads an inactive row — the membership
-- check and the readiness endpoint both require active = true.
create or replace function public.emergency_deactivate_member(
  p_email text,
  p_agency text
)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_count integer;
begin
  if not public.emergency_is_platform_admin() then
    raise exception 'Only a platform administrator may revoke agency access.'
      using errcode = 'insufficient_privilege';
  end if;

  select u.id into v_user_id from auth.users u where lower(u.email) = lower(trim(p_email));
  if v_user_id is null then
    raise exception 'No account exists for %.', p_email using errcode = 'no_data_found';
  end if;

  update public.emergency_agency_members
    set active = false
    where user_id = v_user_id and agency = p_agency and active;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A roster view for the admin doing the activating, so checking who has access
-- does not mean querying auth.users directly. Platform admins only.
create or replace function public.emergency_agency_roster()
returns table (email text, agency text, role text, active boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if not public.emergency_is_platform_admin() then
    raise exception 'Only a platform administrator may read the agency roster.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select u.email::text, m.agency, m.role, m.active, m.created_at
    from public.emergency_agency_members m
    join auth.users u on u.id = m.user_id
    order by m.agency, m.active desc, u.email;
end;
$$;

revoke all on function public.emergency_activate_member(text,text,text,text) from public, anon;
revoke all on function public.emergency_deactivate_member(text,text) from public, anon;
revoke all on function public.emergency_agency_roster() from public, anon;
grant execute on function public.emergency_activate_member(text,text,text,text) to authenticated;
grant execute on function public.emergency_deactivate_member(text,text) to authenticated;
grant execute on function public.emergency_agency_roster() to authenticated;

comment on function public.emergency_activate_member(text,text,text,text) is
  'Grant a PRE-EXISTING account access to a PNP or MDRRMO console. Platform admins only. Never creates logins. Idempotent: re-running reactivates and updates the role.';
comment on function public.emergency_deactivate_member(text,text) is
  'Revoke agency console access by setting active = false. Platform admins only. Never deletes the row, so the record of who held access survives the revocation.';
comment on function public.emergency_agency_roster() is
  'Who currently holds agency console access. Platform admins only.';
