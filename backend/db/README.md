# Database — Recklein Case Engine

## Stack
Supabase (PostgreSQL 15+)

## Migrations

Apply in order against your Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f migrations/001_initial_schema.sql
psql "$SUPABASE_DB_URL" -f migrations/002_seed_recklein_case.sql
```

Or paste each file into the Supabase SQL editor and run.

## Tables

| Table | Purpose |
|---|---|
| `cases` | Root record — one row for the Recklein matter |
| `people` | All individuals: defendant, prosecutors, judges, attorneys, witnesses |
| `courts` | Per-state/per-jurisdiction court records |
| `events` | Full case timeline: hearings, filings, deadlines, orders |
| `documents` | All filings, discovery, evidence, transcripts |
| `flags` | Agent- and manual-raised issues; primary agent output surface |
| `notes` | Strategy memos, research, morning briefs, thought-partner outputs |
| `foia_requests` | FOIA/records request tracking across agencies |
| `emails` | Inbound and outbound email records |
| `faxes` | Inbound and outbound fax records |

## Key Design Decisions

- All PKs are `uuid` — compatible with Supabase RLS row-level security policies.
- `case_id` FK cascades on delete across all child tables.
- **Single-person, multi-case**: `cases.person_id` links every case back to the same subject record in `people`. Because `people` references `cases` and `cases` references `people`, the back-reference is added via `ALTER TABLE` after both tables exist — the only safe way to resolve the circular FK in PostgreSQL.
- `documents.source_system` tracks provenance (PACER, email, fax, manual, FOIA).
- `documents.is_redacted` + `flags.requires_redaction` form the redaction workflow surface.
- `flags` is the shared output bus for all agents — query by `severity` and `status` for the morning brief.
- Partial indexes on boolean columns (`is_brady`, `is_redacted`, `is_critical`, `requires_redaction`) keep agent queries fast.
