-- Emergency trigger functions are internal database machinery, not RPCs.
-- PostgreSQL grants new functions to PUBLIC by default. Remove browser-role
-- execution while preserving service-role access for backend operations.

revoke all on function public.emergency_freeze_resident_fields()
  from public, anon, authenticated;
revoke all on function public.emergency_intake_priority_guard()
  from public, anon, authenticated;
revoke all on function public.emergency_log_incident_change()
  from public, anon, authenticated;
revoke all on function public.emergency_touch_incident()
  from public, anon, authenticated;
revoke all on function public.emergency_validate_assignment()
  from public, anon, authenticated;

grant execute on function public.emergency_freeze_resident_fields()
  to service_role;
grant execute on function public.emergency_intake_priority_guard()
  to service_role;
grant execute on function public.emergency_log_incident_change()
  to service_role;
grant execute on function public.emergency_touch_incident()
  to service_role;
grant execute on function public.emergency_validate_assignment()
  to service_role;
