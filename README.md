# Masinloc Incident Response

Dedicated source repository for the Masinloc Connect incident-reporting and emergency-response subsystem.

## Purpose

This repository is being extracted from `masinlocandher-max/Masinloc-Website` so the resident reporting flow, PNP console, MDRRMO console, offline delivery queue, location handling, responder messaging, audit history, database policies, and emergency-response Edge Function can be maintained and tested independently from the public website.

## Safety rule

Do not redirect production traffic or remove the existing `/emergency/` implementation from `Masinloc-Website` until this repository has passed an end-to-end parity and security review.

## Current migration source

Canonical extraction source during the migration:

- Repository: `masinlocandher-max/Masinloc-Website`
- Resident UI: `emergency/`
- Responder UI: `emergency/pnp.html`, `emergency/mdrrmo.html`, `emergency/agency.js`
- Backend: `supabase/functions/emergency-response/`
- Database: emergency-specific migrations under `supabase/migrations/`

No service-role keys, passwords, private responder credentials, or other secrets belong in this repository.
