import { supabase } from './supabase_client.js';

export async function createPerson({
  case_id,
  full_name,
  role,
  organization,
  email,
  phone,
  address,
  notes
}) {
  return await supabase
    .from('people')
    .insert({ case_id, full_name, role, organization, email, phone, address, notes })
    .select()
    .single();
}

export async function updatePerson(id, fields) {
  return await supabase
    .from('people')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
}

export async function deletePerson(id) {
  return await supabase
    .from('people')
    .delete()
    .eq('id', id);
}

export async function getPersonById(id) {
  return await supabase
    .from('people')
    .select('*')
    .eq('id', id)
    .single();
}

export async function getPeopleByCase(case_id) {
  return await supabase
    .from('people')
    .select('*')
    .eq('case_id', case_id)
    .order('role')
    .order('full_name');
}

export async function getPeopleByRole(case_id, role) {
  return await supabase
    .from('people')
    .select('*')
    .eq('case_id', case_id)
    .eq('role', role)
    .order('full_name');
}

export async function searchPeople(query) {
  return await supabase
    .from('people')
    .select('*')
    .or(`full_name.ilike.%${query}%,organization.ilike.%${query}%,email.ilike.%${query}%`)
    .order('full_name');
}

// Links an existing person record to a case by updating people.case_id.
// Distinct from person_case_link.js which sets cases.person_id (primary defendant).
export async function linkPersonToCase(person_id, case_id) {
  return await supabase
    .from('people')
    .update({ case_id })
    .eq('id', person_id)
    .select()
    .single();
}
