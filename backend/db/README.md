# Database — Recklein Case Engine

## Stack
Supabase (PostgreSQL 15+)

## Migrations

Apply **in order** against your Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f migrations/001_initial_schema.sql
psql "$SUPABASE_DB_URL" -f migrations/002_seed_recklein_case.sql
psql "$SUPABASE_DB_URL" -f migrations/003_notifications.sql
```

Or paste each file into the **Supabase SQL Editor** and run sequentially.

> **Tip:** After applying migrations, copy the `person_id` UUID from the seed
> output and set it as `PRIMARY_PERSON_ID` in your `.env` file, then run
> `npm run check` to verify connectivity.

## Tables

| Table | Purpose |
|---|---|
| `cases` | Root record — one row per Recklein matter (TX, IL, MO) |
| `people` | All individuals: defendant, prosecutors, judges, attorneys, witnesses |
| `courts` | Per-state/per-jurisdiction court records |
| `events` | Full case timeline: hearings, filings, deadlines, orders |
| `documents` | All filings, discovery, evidence, transcripts |
| `flags` | Agent- and manual-raised issues; primary agent output surface |
| `notes` | Strategy memos, research, morning briefs, thought-partner outputs |
| `foia_requests` | FOIA/records request tracking across agencies |
| `notifications` | Active alerts: FOIA deadlines, court dates, flag escalations, follow-ups |
| `emails` | Inbound and outbound email records |
| `faxes` | Inbound and outbound fax records |

## Key Design Decisions

- All PKs are `uuid` — compatible with Supabase RLS row-level security policies.
- `case_id` FK cascades on delete across all child tables.
- **Single-person, multi-case**: `cases.person_id` links every case back to the same
  subject record in `people`. The back-reference is added via `ALTER TABLE` after
  both tables exist — the only safe way to break the circular FK in PostgreSQL.
- `documents.source_system` tracks provenance (PACER, email, fax, manual, FOIA).
- `documents.doc_type` (not `document_type`) — motion, order, brief, evidence, etc.
- `documents.summary` (not `normalized_text`) — AI-generated summary field.
- `documents.is_redacted` + `flags.requires_redaction` form the redaction workflow.
- `flags` is the shared output bus for all agents — query by `severity` and `status`.
- `notifications` uses a partial unique index on `(entity_id, alert_type) WHERE
  is_dismissed = false` to deduplicate active alerts at the DB level.
- Partial indexes on boolean columns (`is_brady`, `is_redacted`, `is_critical`,
  `requires_redaction`) keep agent queries fast on large document sets.

## Speedy Trial Statutes (enforced in backend/workflows.js)

| State | Rule | Days |
|---|---|---|
| TX | Art. 32A.02 CCP | 180 |
| IL | Rule 103(b) | 120 |
| MO | Rule 33.01 | 180 |
