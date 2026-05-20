import { supabase } from './supabase_client.js';

const DEFAULT_LIMIT = 20;

function applyCase(query, case_id) {
  return case_id ? query.eq('case_id', case_id) : query;
}

export async function searchCases(q, { limit = DEFAULT_LIMIT } = {}) {
  const { data, error } = await supabase
    .from('cases')
    .select('id, case_number, title, state, county, jurisdiction, status, case_type, filed_date')
    .or(
      `title.ilike.%${q}%,` +
      `case_number.ilike.%${q}%,` +
      `county.ilike.%${q}%,` +
      `state.ilike.%${q}%,` +
      `notes.ilike.%${q}%`
    )
    .limit(limit);
  return { entity: 'case', data: data ?? [], error: error?.message ?? null };
}

export async function searchNotes(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const base = supabase
    .from('notes')
    .select('id, case_id, note_type, title, body, author, is_privileged, created_at')
    .or(
      `title.ilike.%${q}%,` +
      `body.ilike.%${q}%,` +
      `note_type.ilike.%${q}%,` +
      `author.ilike.%${q}%`
    )
    .limit(limit);
  const { data, error } = await applyCase(base, case_id);
  return { entity: 'note', data: data ?? [], error: error?.message ?? null };
}

export async function searchDocuments(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const base = supabase
    .from('documents')
    .select('id, case_id, title, doc_type, source_system, filed_date, is_brady, is_redacted, summary, bates_number')
    .or(
      `title.ilike.%${q}%,` +
      `summary.ilike.%${q}%,` +
      `doc_type.ilike.%${q}%,` +
      `source_system.ilike.%${q}%,` +
      `bates_number.ilike.%${q}%`
    )
    .limit(limit);
  const { data, error } = await applyCase(base, case_id);
  return { entity: 'document', data: data ?? [], error: error?.message ?? null };
}

export async function searchFOIA(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const base = supabase
    .from('foia_requests')
    .select('id, case_id, agency, state, status, request_date, due_date, response_date, request_body, response_notes')
    .or(
      `agency.ilike.%${q}%,` +
      `request_body.ilike.%${q}%,` +
      `response_notes.ilike.%${q}%,` +
      `state.ilike.%${q}%`
    )
    .limit(limit);
  const { data, error } = await applyCase(base, case_id);
  return { entity: 'foia_request', data: data ?? [], error: error?.message ?? null };
}

export async function searchFlags(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const base = supabase
    .from('flags')
    .select('id, case_id, flag_type, violation_type, severity, title, description, status, raised_by, requires_redaction, created_at')
    .or(
      `title.ilike.%${q}%,` +
      `description.ilike.%${q}%,` +
      `violation_type.ilike.%${q}%,` +
      `flag_type.ilike.%${q}%,` +
      `raised_by.ilike.%${q}%`
    )
    .limit(limit);
  const { data, error } = await applyCase(base, case_id);
  return { entity: 'flag', data: data ?? [], error: error?.message ?? null };
}

export async function searchPeople(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const base = supabase
    .from('people')
    .select('id, case_id, full_name, role, organization, email, phone')
    .or(
      `full_name.ilike.%${q}%,` +
      `organization.ilike.%${q}%,` +
      `email.ilike.%${q}%,` +
      `notes.ilike.%${q}%`
    )
    .limit(limit);
  const { data, error } = await applyCase(base, case_id);
  return { entity: 'person', data: data ?? [], error: error?.message ?? null };
}

export async function searchAll(q, { case_id, limit = DEFAULT_LIMIT } = {}) {
  const opts = { case_id, limit };
  const [cases, notes, documents, foia, flags, people] = await Promise.all([
    searchCases(q, { limit }),
    searchNotes(q, opts),
    searchDocuments(q, opts),
    searchFOIA(q, opts),
    searchFlags(q, opts),
    searchPeople(q, opts)
  ]);

  const groups = { cases, notes, documents, foia_requests: foia, flags, people };
  let total_count = 0;
  const results = {};

  for (const [key, group] of Object.entries(groups)) {
    results[key] = { count: group.data.length, data: group.data, error: group.error };
    total_count += group.data.length;
  }

  return { query: q, case_id: case_id ?? null, total_count, results };
}
