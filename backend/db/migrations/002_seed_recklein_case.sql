-- Recklein Case Engine — Seed: Root Case Record
-- Migration: 002_seed_recklein_case
-- Creates the single root case record this system is built around.

INSERT INTO cases (
  case_number,
  title,
  state,
  county,
  jurisdiction,
  jurisdiction_type,
  status,
  case_type,
  notes
) VALUES (
  NULL,                       -- fill in once docket numbers are confirmed
  'Recklein Matter',
  NULL,                       -- multi-state; populate per court record in courts table
  NULL,
  'Multi-State',
  'multi-state',
  'active',
  'criminal',
  'Root case record for the multi-state Recklein matter. All courts, events, documents, and people attach to this case.'
);
