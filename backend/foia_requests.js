import { supabase } from './supabase_client.js';

export async function createFOIARequest({
  case_id,
  agency,
  state,
  contact_id,
  request_date,
  due_date,
  request_body
}) {
  return await supabase
    .from('foia_requests')
    .insert({
      case_id,
      agency,
      state,
      contact_id,
      request_date,
      due_date,
      request_body,
      status: 'drafted'
    })
    .select()
    .single();
}

export async function updateFOIARequest(id, fields) {
  return await supabase
    .from('foia_requests')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
}

export async function getFOIARequestsByCase(case_id) {
  return await supabase
    .from('foia_requests')
    .select('*')
    .eq('case_id', case_id)
    .order('created_at', { ascending: false });
}

export async function getFOIARequestById(id) {
  return await supabase
    .from('foia_requests')
    .select('*')
    .eq('id', id)
    .single();
}

export async function getOverdueFOIARequests() {
  const today = new Date().toISOString().split('T')[0];
  return await supabase
    .from('foia_requests')
    .select('*')
    .in('status', ['sent', 'acknowledged'])
    .lt('due_date', today)
    .order('due_date', { ascending: true });
}
