import { supabase } from './supabase_client.js';

export async function createCourt({
  case_id,
  name,
  state,
  county,
  division,
  court_type,
  docket_number,
  judge_id,
  notes
}) {
  return await supabase
    .from('courts')
    .insert({ case_id, name, state, county, division, court_type, docket_number, judge_id, notes })
    .select()
    .single();
}

export async function updateCourt(id, fields) {
  return await supabase
    .from('courts')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
}

export async function deleteCourt(id) {
  return await supabase
    .from('courts')
    .delete()
    .eq('id', id);
}

export async function getCourtById(id) {
  return await supabase
    .from('courts')
    .select('*, judge:judge_id(id, full_name, role, organization)')
    .eq('id', id)
    .single();
}

export async function getCourtsByCase(case_id) {
  return await supabase
    .from('courts')
    .select('*, judge:judge_id(id, full_name, role, organization)')
    .eq('case_id', case_id)
    .order('state')
    .order('name');
}

export async function getCourtsByState(state) {
  return await supabase
    .from('courts')
    .select('*, judge:judge_id(id, full_name, role, organization)')
    .eq('state', state)
    .order('name');
}

export async function searchCourts(query) {
  return await supabase
    .from('courts')
    .select('*, judge:judge_id(id, full_name, role, organization)')
    .or(`name.ilike.%${query}%,county.ilike.%${query}%,docket_number.ilike.%${query}%`)
    .order('name');
}

export async function assignJudge(court_id, judge_id) {
  return await supabase
    .from('courts')
    .update({ judge_id })
    .eq('id', court_id)
    .select('*, judge:judge_id(id, full_name, role, organization)')
    .single();
}

export async function linkCourtToCase(court_id, case_id) {
  return await supabase
    .from('courts')
    .update({ case_id })
    .eq('id', court_id)
    .select()
    .single();
}
