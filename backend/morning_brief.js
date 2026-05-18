import { supabase } from './supabase_client.js';

export async function generateMorningBrief(person_id) {
  const { data: flags } = await supabase
    .from('flags')
    .select('*')
    .eq('person_id', person_id)
    .order('severity', { ascending: false });

  const { data: events } = await supabase
    .from('events')
    .select('*')
    .eq('person_id', person_id)
    .order('event_date', { ascending: true });

  return {
    daily_summary: `Morning Brief for person ${person_id}`,
    critical_items: flags.filter(f => f.severity === 'critical'),
    recommended_actions: deriveActions(flags, events)
  };
}

function deriveActions(flags, events) {
  return [
    ...flags
      .filter(f => f.severity === 'high' || f.severity === 'critical')
      .map(f => `Address violation: ${f.violation_type}`),
    ...events
      .filter(e => e.is_critical)
      .map(e => `Prepare for critical event: ${e.event_type}`)
  ];
}
