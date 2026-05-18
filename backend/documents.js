import { supabase } from './supabase_client.js';

export async function storeDocument({
  case_id,
  person_id,
  file_path,
  source_system,
  normalized_text,
  document_type,
  origin_state,
  origin_county,
  needs_redaction
}) {
  return await supabase
    .from('documents')
    .insert({
      case_id,
      person_id,
      file_path,
      source_system,
      normalized_text,
      document_type,
      origin_state,
      origin_county,
      needs_redaction
    })
    .select()
    .single();
}
