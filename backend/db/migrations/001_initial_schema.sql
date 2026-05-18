-- Recklein Case Engine — Initial Schema
-- Migration: 001_initial_schema
-- Apply via: psql $DATABASE_URL -f 001_initial_schema.sql
--            or Supabase SQL editor

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- CASES
-- ============================================================
CREATE TABLE cases (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number         text,
  title               text        NOT NULL,
  state               text,
  county              text,
  jurisdiction        text,
  jurisdiction_type   text,                   -- state | federal | multi-state | tribal
  status              text,                   -- active | closed | appealing | stayed
  case_type           text,                   -- criminal | civil | administrative
  filed_date          date,
  closed_date         date,
  notes               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

-- ============================================================
-- PEOPLE
-- ============================================================
CREATE TABLE people (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  full_name     text        NOT NULL,
  role          text,       -- defendant | prosecutor | judge | attorney | witness | investigator | contact
  organization  text,
  email         text,
  phone         text,
  address       text,
  notes         text,
  created_at    timestamptz DEFAULT now()
);

-- ============================================================
-- COURTS
-- ============================================================
CREATE TABLE courts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  state         text,
  county        text,
  division      text,
  court_type    text,       -- district | circuit | appellate | supreme | federal
  docket_number text,
  judge_id      uuid        REFERENCES people(id),
  notes         text,
  created_at    timestamptz DEFAULT now()
);

-- ============================================================
-- EVENTS
-- ============================================================
CREATE TABLE events (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        uuid        REFERENCES cases(id) ON DELETE CASCADE,
  court_id       uuid        REFERENCES courts(id),
  event_type     text,       -- hearing | filing | deadline | order | arrest | contact | misc
  title          text        NOT NULL,
  description    text,
  event_date     timestamptz,
  deadline_date  timestamptz,
  is_critical    boolean     DEFAULT false,
  status         text,       -- scheduled | completed | missed | continued
  created_by     text,
  created_at     timestamptz DEFAULT now()
);

-- ============================================================
-- DOCUMENTS
-- ============================================================
CREATE TABLE documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid        REFERENCES cases(id) ON DELETE CASCADE,
  court_id          uuid        REFERENCES courts(id),
  event_id          uuid        REFERENCES events(id),
  title             text        NOT NULL,
  doc_type          text,       -- motion | order | brief | evidence | transcript | exhibit | correspondence
  file_path         text,       -- Supabase Storage path
  file_url          text,
  filed_date        date,
  filed_by_id       uuid        REFERENCES people(id),
  bates_number      text,
  source_system     text,       -- e.g. "pacer" | "email" | "fax" | "manual" | "foia"
  is_brady          boolean     DEFAULT false,
  is_privileged     boolean     DEFAULT false,
  is_redacted       boolean     DEFAULT false,
  redaction_reason  text,
  redacted_by       text,
  redacted_at       timestamptz,
  summary           text,       -- AI-generated summary
  tags              text[],
  created_at        timestamptz DEFAULT now()
);

-- ============================================================
-- FLAGS
-- ============================================================
CREATE TABLE flags (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              uuid        REFERENCES cases(id) ON DELETE CASCADE,
  document_id          uuid        REFERENCES documents(id),
  event_id             uuid        REFERENCES events(id),
  person_id            uuid        REFERENCES people(id),
  flag_type            text,       -- brady | deadline | inconsistency | pattern | foia | judicial_conduct | misc
  violation_type       text,       -- constitutional | statutory | procedural | ethical | evidentiary
  severity             text,       -- critical | high | medium | low
  title                text        NOT NULL,
  description          text,
  raised_by            text,       -- agent name or "manual"
  requires_redaction   boolean     DEFAULT false,
  status               text        DEFAULT 'open',  -- open | resolved | dismissed | escalated
  resolved_at          timestamptz,
  created_at           timestamptz DEFAULT now()
);

-- ============================================================
-- NOTES
-- ============================================================
CREATE TABLE notes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  document_id   uuid        REFERENCES documents(id),
  event_id      uuid        REFERENCES events(id),
  person_id     uuid        REFERENCES people(id),
  flag_id       uuid        REFERENCES flags(id),
  note_type     text,       -- strategy | observation | research | morning_brief | thought_partner | misc
  title         text,
  body          text        NOT NULL,
  author        text,       -- agent name or user name
  is_privileged boolean     DEFAULT false,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- ============================================================
-- FOIA REQUESTS
-- ============================================================
CREATE TABLE foia_requests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid        REFERENCES cases(id) ON DELETE CASCADE,
  agency          text        NOT NULL,
  state           text,
  contact_id      uuid        REFERENCES people(id),
  request_date    date,
  due_date        date,
  response_date   date,
  status          text,       -- drafted | sent | acknowledged | partial | fulfilled | denied | appealed | overdue
  request_body    text,
  response_notes  text,
  document_id     uuid        REFERENCES documents(id),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- ============================================================
-- EMAILS
-- ============================================================
CREATE TABLE emails (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  direction     text,       -- inbound | outbound
  from_address  text,
  to_addresses  text[],
  cc_addresses  text[],
  subject       text,
  body_text     text,
  body_html     text,
  sent_at       timestamptz,
  received_at   timestamptz,
  thread_id     text,
  message_id    text,
  person_id     uuid        REFERENCES people(id),
  document_id   uuid        REFERENCES documents(id),
  tags          text[],
  created_at    timestamptz DEFAULT now()
);

-- ============================================================
-- FAXES
-- ============================================================
CREATE TABLE faxes (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid        REFERENCES cases(id) ON DELETE CASCADE,
  direction     text,       -- inbound | outbound
  from_number   text,
  to_number     text,
  pages         int,
  status        text,       -- queued | sent | delivered | failed | received
  sent_at       timestamptz,
  received_at   timestamptz,
  fax_sid       text,       -- Twilio or provider reference ID
  document_id   uuid        REFERENCES documents(id),
  person_id     uuid        REFERENCES people(id),
  notes         text,
  created_at    timestamptz DEFAULT now()
);

-- ============================================================
-- CASES ← PEOPLE back-reference (deferred to break circular FK)
-- cases must exist before people; people must exist before this ALTER
-- ============================================================
ALTER TABLE cases
  ADD COLUMN person_id uuid REFERENCES people(id);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_cases_person_id       ON cases(person_id);
CREATE INDEX idx_people_case_id        ON people(case_id);
CREATE INDEX idx_courts_case_id       ON courts(case_id);
CREATE INDEX idx_events_case_id       ON events(case_id);
CREATE INDEX idx_events_deadline_date ON events(deadline_date) WHERE deadline_date IS NOT NULL;
CREATE INDEX idx_events_is_critical   ON events(is_critical)   WHERE is_critical = true;
CREATE INDEX idx_documents_case_id    ON documents(case_id);
CREATE INDEX idx_documents_is_brady   ON documents(is_brady)   WHERE is_brady = true;
CREATE INDEX idx_documents_is_redacted ON documents(is_redacted) WHERE is_redacted = true;
CREATE INDEX idx_flags_case_id        ON flags(case_id);
CREATE INDEX idx_flags_status         ON flags(status);
CREATE INDEX idx_flags_severity       ON flags(severity);
CREATE INDEX idx_flags_requires_redaction ON flags(requires_redaction) WHERE requires_redaction = true;
CREATE INDEX idx_notes_case_id        ON notes(case_id);
CREATE INDEX idx_foia_requests_case_id ON foia_requests(case_id);
CREATE INDEX idx_foia_requests_status  ON foia_requests(status);
CREATE INDEX idx_emails_case_id       ON emails(case_id);
CREATE INDEX idx_faxes_case_id        ON faxes(case_id);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cases_updated_at
  BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_foia_requests_updated_at
  BEFORE UPDATE ON foia_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
