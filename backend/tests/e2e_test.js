import { ingest } from "../ingestion/router.js";
import { supabase } from "../supabase_client.js";
import { generateMorningBrief } from "../morning_brief.js";

async function runE2E() {
  const person_id = process.env.PRIMARY_PERSON_ID;

  // Get any case for this person
  const { data: cases } = await supabase
    .from("cases")
    .select("*")
    .eq("person_id", person_id)
    .limit(1);

  if (!cases || cases.length === 0) {
    console.error("No cases found for person");
    return;
  }

  const case_id = cases[0].id;

  console.log("Running E2E test for case:", case_id);

  // Sample text simulating a PDF
  const sampleText = `
    COURT DOCUMENT — SAMPLE
    Case Number: 12345
    County: Palo Pinto
    State: TX
    Hearing missed due to failed mail.
    FTA issued incorrectly.
    Speedy trial exceeded.
  `;

  // Ingest the sample text as a PDF
  const result = await ingest("pdf", {
    case_id,
    person_id,
    file_path: "sample.pdf",
    raw_text: sampleText
  });

  console.log("Ingestion result:", result);

  // Fetch flags
  const { data: flags } = await supabase
    .from("flags")
    .select("*")
    .eq("case_id", case_id)
    .order("created_at", { ascending: false });

  console.log("Flags:", flags);

  // Fetch documents
  const { data: docs } = await supabase
    .from("documents")
    .select("*")
    .eq("case_id", case_id)
    .order("created_at", { ascending: false });

  console.log("Documents:", docs);

  // Generate morning brief
  const brief = await generateMorningBrief(person_id);
  console.log("Morning Brief:", brief);

  console.log("E2E test complete.");
}

runE2E();
