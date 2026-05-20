import { supabase } from './supabase_client.js';

export async function createNote({
  case_id,
  document_id,
  event_id,
  person_id,
  flag_id,
  note_type,
  title,
  body,
  author,
  is_privileged
}) {
  return await supabase
    .from('notes')
    .insert({
      case_id,
      document_id,
      event_id,
      person_id,
      flag_id,
      note_type,
      title,
      body,
      author,
      is_privileged
    })
    .select()
    .single();
}

export async function getNotesByCase(case_id) {
  return await supabase
    .from('notes')
    .select('*')
    .eq('case_id', case_id)
    .order('created_at', { ascending: false });
}

export async function getNotesByFlag(flag_id) {
  return await supabase
    .from('notes')
    .select('*')
    .eq('flag_id', flag_id)
    .order('created_at', { ascending: false });
}

export async function getNotesByType(case_id, note_type) {
  return await supabase
    .from('notes')
    .select('*')
    .eq('case_id', case_id)
    .eq('note_type', note_type)
    .order('created_at', { ascending: false });
}
