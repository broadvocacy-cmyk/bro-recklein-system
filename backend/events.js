import { supabase } from './supabase_client.js';

export async function createEvent({
  case_id,
  person_id,
  event_type,
  event_date,
  description,
  is_critical
}) {
  return await supabase
    .from('events')
    .insert({
      case_id,
      person_id,
      event_type,
      event_date,
      description,
      is_critical
    })
    .select()
    .single();
}
