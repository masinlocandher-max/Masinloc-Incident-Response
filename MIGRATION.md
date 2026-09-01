# Emergency system extraction and cutover plan

This repository is being populated from `masinlocandher-max/Masinloc-Website` without changing production routing during extraction.

## Pinned website source

The UI/runtime extraction is pinned to this exact upstream snapshot:

- Repository: `masinlocandher-max/Masinloc-Website`
- Commit: `4e74f25e59123aed6e09afc924162de983421052`
- Tree: `0042fc2fe5122c971ed9e64919ba269b043f1662`
- Blob lock: `migration/upstream-blobs.json`

If `Masinloc-Website/main` moves again, do not silently mix files from different snapshots. Review the new commits, update the pin deliberately, then refresh affected hashes.

## Production reconciliation

A read-only reconciliation was performed against Supabase project `uwcqvsitjtknxsaypjxj`. No production rows were read and no production schema, function or routing change was made.

Machine-readable evidence is in `migration/production-reconciliation.json`.

Production currently records these emergency migrations:

1. `20260831065300 emergency_response_core`
2. `20260831071020 emergency_response_hardening`
3. `20260901014733 emergency_report_mode_and_resident_immutability`
4. `20260901014758 emergency_member_activation`
5. `20260901014821 emergency_reporter_account`
6. `20260901023745 revoke_emergency_trigger_rpc_execution`

Two migrations had been applied in production but were missing from the pinned website repository. They have now been recovered from production migration history and committed here exactly:

- `supabase/migrations/20260901014758_emergency_member_activation.sql`
- `supabase/migrations/20260901014821_emergency_reporter_account.sql`

The production history version for `emergency_report_mode_and_resident_immutability` differs from the filename carried by the source repo. This is recorded explicitly rather than renaming history silently.

## Critical live Edge Function drift

The deployed production `emergency-response` Edge Function is version 3 and is older than the source now carried by this repository.

Production drift confirmed during read-only inspection:

- The deployed submit path does not persist `report_mode`.
- Because the database defaults `report_mode` to `emergency`, an Assistance submission handled by the old deployed function can be stored as Emergency.
- The live database contains optional `reporter_user_id` account-linking schema and reporter RLS policies, but the currently pinned resident runtime and deployed Edge Function do not wire that optional account linkage end to end.

Do not deploy the corrected function directly to production until it has passed an isolated database + Edge Function test and rollback is prepared.

## Emergency subsystem

- `emergency/index.html` — resident reporting interface
- `emergency/emergency.js` — resident offline queue, GPS, delivery/status and messaging
- `emergency/emergency.css`
- `emergency/manifest.webmanifest`
- `emergency/sw.js` — offline shell and background sync
- `emergency/pnp.html` — PNP console
- `emergency/mdrrmo.html` — MDRRMO console
- `emergency/agency.js` — shared authenticated responder controller
- `emergency/agency.css`
- `emergency/map.js`
- `supabase/functions/emergency-response/index.ts` — public intake/status/message Edge Function
- `supabase/migrations/20260831143000_emergency_response_core.sql`
- `supabase/migrations/20260831152000_emergency_response_hardening.sql`
- `supabase/migrations/20260831160000_emergency_report_mode_and_resident_immutability.sql`
- `supabase/migrations/20260901014758_emergency_member_activation.sql`
- `supabase/migrations/20260901014821_emergency_reporter_account.sql`
- `supabase/migrations/20260901023745_revoke_emergency_trigger_rpc_execution.sql`
- `scripts/emergency-qa.mjs`
- `scripts/emergency-browser-qa.mjs`
- `scripts/check-emergency-consolidation.py`

Shared static/navigation dependencies are copied into this repo:

- `tokens.css`
- `assets/vendor/supabase.js`
- `assets/favicon.svg`
- `assets/apple-touch-icon.png`
- `assets/masinloc-logo.webp`
- `connect.html`

## Exact provenance gate

Run:

```bash
node scripts/verify-upstream-parity.mjs
```

The verifier computes the Git blob SHA-1 of every required website-derived target file and compares it with `migration/upstream-blobs.json`.

- `MATCH` means byte-for-byte parity with the pinned website source.
- `MISSING` blocks cutover.
- `MISMATCH` blocks cutover.
- `--allow-missing` exists only to report migration progress. It is never a cutover pass.

The two production-recovered migrations are intentionally tracked separately in `migration/production-reconciliation.json` because they were not present in the pinned website commit.

## Migration rules

1. Preserve behavior before redesigning.
2. Do not remove or redirect `/emergency/` in `Masinloc-Website` during extraction.
3. Do not replay production migrations into production merely because they are now represented in this repo.
4. Never commit the Supabase service-role key or responder credentials.
5. Keep resident auth optional. Incident reporting must remain possible without account creation or sign-in.
6. `Saved Offline · Not Yet Received`, `Received`, and `Acknowledged` are distinct states and must never be collapsed.
7. Resident-submitted evidence, identity and attribution fields remain immutable to normal responder accounts.
8. PNP and MDRRMO access is granted by authenticated agency membership/RLS, not hidden URLs or client-side checks.
9. Assistance mode is resident intent, not responder priority. Intake must never derive operational priority from it.
10. Trigger-only emergency database functions remain revoked from `PUBLIC`, `anon`, and `authenticated`; they are not browser RPC endpoints.
11. Optional reporter-account linkage may improve cross-device follow-up, but it must never become a prerequisite for reporting.
12. Production cutover requires a tested rollback path to the existing website implementation.
13. The website remains the production authority until every blocking gate below passes and the migration PR is deliberately promoted.

## Verification completed

The extracted branch has passed:

- [x] Strict upstream parity for every website-derived locked file.
- [x] JavaScript syntax checks.
- [x] Emergency contract QA.
- [x] Emergency consolidation/security check.
- [x] Three consecutive isolated Playwright emergency browser runs.
- [x] Resident GPS and manual-location browser paths in mocked browser QA.
- [x] Offline `Not Yet Received` behavior and reconnect delivery in mocked browser QA.
- [x] PNP and MDRRMO signed-out gates and mocked authorized console rendering.
- [x] Read-only production RLS/policy inspection.
- [x] Trigger-only RPC revocation confirmed live.
- [x] Production migration history reconciled and missing migration source recovered.

The browser suite intercepts the emergency Edge Function, Supabase auth/REST endpoints and map tiles; it does not generate real production incidents or responder actions.

## Remaining blocking cutover gates

Do not redirect production traffic until all of these pass:

- [ ] Create or otherwise provide an isolated Supabase environment based on current production schema.
- [ ] Verify all six emergency migrations can be represented/replayed consistently in that isolated environment.
- [ ] Deploy the corrected repo `emergency-response` function only to the isolated environment.
- [ ] Confirm isolated submit persists `report_mode=emergency` for Emergency reports.
- [ ] Confirm isolated submit persists `report_mode=assistance` for Assistance reports.
- [ ] Confirm duplicate submit is idempotent and cannot change incident identity.
- [ ] Confirm anonymous submit/status/message still work without an account.
- [ ] Decide whether reporter-account runtime wiring is in this cutover or explicitly deferred; either choice must preserve anonymous reporting.
- [ ] If reporter-account wiring is included, test that a signed-in resident sees only their own report/public messages and cannot see internal notes.
- [ ] Test PNP user can only access authorized PNP-linked incidents.
- [ ] Test MDRRMO user can only access authorized MDRRMO-linked incidents.
- [ ] Test cross-agency referral.
- [ ] Test public responder reply reaches resident thread.
- [ ] Test internal responder note never reaches resident thread.
- [ ] Test responder cannot modify frozen resident fields including `reporter_user_id`.
- [ ] Confirm status/priority/assignment audit events are recorded.
- [ ] Confirm production CORS/origin list for the final host before deployment.
- [ ] Prepare and test production Edge Function rollback procedure.
- [ ] Only then deploy the corrected function to production and perform a controlled smoke test.
- [ ] Only after production backend verification consider redirecting website/app traffic or changing repository ownership boundaries.

## Current state

Branch: `migration/extract-emergency-system`

The incident-response repository is now source-complete for the known live emergency database history and byte-complete for the pinned website emergency subsystem.

It is **not yet approved for production cutover** because the deployed production Edge Function is stale and the corrected database/function combination still needs isolated verification.

Production routing, live database schema and the currently deployed production Edge Function remain unchanged by this migration work.
