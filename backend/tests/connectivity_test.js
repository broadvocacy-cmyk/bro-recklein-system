import '../config.js';
import { supabase } from '../supabase_client.js';

const TABLES = [
  'cases', 'people', 'courts', 'events', 'documents',
  'flags', 'notes', 'foia_requests', 'notifications', 'emails', 'faxes'
];

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}: ${e.message}`);
    failed++;
  }
}

async function run() {
  console.log('\nRecklein Case Engine — Connectivity & Schema Check\n');

  console.log('Environment');
  await check('SUPABASE_URL set',              async () => { if (!process.env.SUPABASE_URL)              throw new Error('missing'); });
  await check('SUPABASE_SERVICE_ROLE_KEY set', async () => { if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('missing'); });
  await check('ANTHROPIC_API_KEY set',         async () => { if (!process.env.ANTHROPIC_API_KEY)         throw new Error('missing'); });

  console.log('\nSupabase Tables');
  for (const table of TABLES) {
    await check(`${table} readable`, async () => {
      const { error } = await supabase.from(table).select('id').limit(1);
      if (error) throw new Error(error.message);
    });
  }

  if (process.env.PRIMARY_PERSON_ID) {
    console.log('\nSeed Data');
    await check('PRIMARY_PERSON_ID resolves to a person', async () => {
      const { data, error } = await supabase
        .from('people')
        .select('id, full_name')
        .eq('id', process.env.PRIMARY_PERSON_ID)
        .single();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('person not found');
      console.log(`      → ${data.full_name}`);
    });

    await check('At least one case linked to PRIMARY_PERSON_ID', async () => {
      const { data, error } = await supabase
        .from('cases')
        .select('id, title, state')
        .eq('person_id', process.env.PRIMARY_PERSON_ID)
        .limit(5);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new Error('no cases found');
      data.forEach(c => console.log(`      → [${c.state}] ${c.title}`));
    });
  }

  console.log(`\n── ${passed} passed, ${failed} failed ──\n`);
  if (failed > 0) process.exit(1);
}

run();
