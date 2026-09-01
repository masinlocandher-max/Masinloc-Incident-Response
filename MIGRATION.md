# Emergency system extraction plan

This repository is being populated from `masinlocandher-max/Masinloc-Website` without changing production routing during extraction.

## Pinned source of truth

The migration is pinned to this exact upstream snapshot:

- Repository: `masinlocandher-max/Masinloc-Website`
- Commit: `4e74f25e59123aed6e09afc924162de983421052`
- Tree: `0042fc2fe5122c971ed9e64919ba269b043f1662`
- Blob lock: `migration/upstream-blobs.json`

If `Masinloc-Website/main` moves again, do not silently mix files from different snapshots. Review the new commits, update the pin deliberately, then refresh affected hashes.

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
- `supabase/migrations/20260901023745_revoke_emergency_trigger_rpc_execution.sql`
- `scripts/emergency-qa.mjs`
- `scripts/emergency-browser-qa.mjs`
- `scripts/check-emergency-consolidation.py`

Shared static/navigation dependencies that must be made self-contained or intentionally replaced and retested before deployment:

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

The verifier computes the Git blob SHA-1 of every required target file and compares it with `migration/upstream-blobs.json`.

- `MATCH` means byte-for-byte parity with the pinned production source.
- `MISSING` blocks cutover.
- `MISMATCH` blocks cutover.
- `--allow-missing` exists only to report migration progress. It is never a cutover pass.

Do not recreate an upstream file from truncated connector output, screenshots, copied fragments or memory. If exact bytes cannot be retrieved safely, leave the file missing and keep cutover blocked.

## Migration rules

1. Preserve behavior before redesigning.
2. Do not remove or redirect `/emergency/` in `Masinloc-Website` during extraction.
3. Do not deploy database migrations from this repo merely because they were copied. They belong to the existing production history and must be reconciled against the live Supabase migration state first.
4. Never commit the Supabase service-role key or responder credentials. The Edge Function must continue reading `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from its runtime environment.
5. Keep resident auth optional. An incident report must remain possible without requiring account creation or sign-in.
6. `Saved Offline · Not Yet Received`, `Received`, and `Acknowledged` are distinct states and must never be collapsed.
7. Resident-submitted evidence and report identity fields remain immutable to normal responder accounts.
8. PNP and MDRRMO access is granted by authenticated agency membership/RLS, not by hidden URLs or client-side screen checks.
9. Assistance mode is resident intent, not responder priority. Intake must never automatically downgrade priority.
10. Trigger-only emergency database functions must remain revoked from `PUBLIC`, `anon`, and `authenticated`; they are not browser RPC endpoints.
11. Production cutover requires a tested rollback path to the existing website implementation.
12. The website remains the production authority until every gate below passes and the draft PR is deliberately promoted.

## Cutover gates

Do not redirect production traffic until all of these pass:

- [ ] Strict upstream parity verifier passes with no missing or mismatched required files.
- [ ] Resident UI copied and static dependencies are self-contained.
- [ ] PNP and MDRRMO consoles copied.
- [ ] Emergency QA scripts copied and adapted to this repo.
- [ ] Local/static QA passes.
- [ ] Emergency consolidation check confirms trigger functions are not browser-callable RPCs.
- [ ] Database migration history reconciled against the existing Supabase project.
- [ ] Edge Function parity test passes for submit, duplicate submit, status and resident message.
- [ ] Anonymous report works without an account.
- [ ] Offline report remains clearly `Not Yet Received` until server confirmation.
- [ ] Reconnect sends one logical incident and does not regress a delivered report to offline state.
- [ ] GPS permission accepted, denied and unavailable paths tested.
- [ ] Manual barangay/landmark fallback tested.
- [ ] PNP user can only access authorized PNP-linked incidents.
- [ ] MDRRMO user can only access authorized MDRRMO-linked incidents.
- [ ] Cross-agency support referral tested.
- [ ] Public responder reply reaches resident thread.
- [ ] Internal responder note never reaches resident thread.
- [ ] Responder cannot modify frozen resident fields.
- [ ] Status/priority/assignment audit events are recorded.
- [ ] Mobile browser/PWA test passes.
- [ ] Production CORS/origin list is intentionally configured for the final host.
- [ ] Rollback procedure tested before cutover.

## Current extraction status

Branch: `migration/extract-emergency-system`

Exact upstream copies currently include:

- Resident `index.html`
- PWA manifest
- Service worker
- Responder map runtime
- Emergency Edge Function
- Core emergency schema/RLS migration
- Responder hardening migration
- Report-mode/resident-immutability migration
- Trigger-RPC execution hardening migration

Still intentionally blocked until exact copies are available:

- Resident runtime and CSS
- PNP/MDRRMO responder pages, controller and CSS
- Emergency QA files
- Shared tokens, Supabase browser bundle, images and navigation dependency

Production routing, live Supabase deployment and the existing website emergency implementation remain unchanged.
