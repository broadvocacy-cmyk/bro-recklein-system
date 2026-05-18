import { supabase } from './supabase_client.js';

export async function linkCaseToPerson(person_id, case_id) {
  return await supabase
    .from('cases')
    .update({ person_id })
    .eq('id', case_id)
    .select()
    .single();
}
