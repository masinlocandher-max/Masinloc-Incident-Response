-- Local CI only. The production project already owns this shared platform baseline.
-- The incident-response repo does not duplicate these as production migrations;
-- this bootstrap gives an isolated blank Supabase stack the same shared
-- dependencies that already exist in the full production project.

create schema if not exists private;

create table if not exists public.submission_rate_limits (
  fingerprint text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.check_submission_rate_limit(
  p_fingerprint text,
  p_limit integer default 8,
  p_window_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.submission_rate_limits%rowtype;
begin
  insert into public.submission_rate_limits(fingerprint, window_started_at, request_count, updated_at)
  values (p_fingerprint, v_now, 1, v_now)
  on conflict (fingerprint) do update
    set request_count = case
          when public.submission_rate_limits.window_started_at < v_now - make_interval(secs => p_window_seconds)
            then 1
          else public.submission_rate_limits.request_count + 1
        end,
        window_started_at = case
          when public.submission_rate_limits.window_started_at < v_now - make_interval(secs => p_window_seconds)
            then v_now
          else public.submission_rate_limits.window_started_at
        end,
        updated_at = v_now
  returning * into v_row;

  return v_row.request_count <= p_limit;
end;
$$;
