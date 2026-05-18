import { supabase } from './supabase_client.js';

export async function writeFlag({
  case_id,
  person_id,
  violation_type,
  severity,
  description,
  requires_redaction
}) {
  return await supabase
    .from('flags')
    .insert({
      case_id,
      person_id,
      violation_type,
      severity,
      description,
      requires_redaction
    })
    .select()
    .single();
}
