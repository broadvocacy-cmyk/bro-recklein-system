import { executeAgent } from "../agent_executor.js";
import { storeDocument } from "../documents.js";
import { writeFlag } from "../flags.js";
import { createEvent } from "../events.js";

export async function ingestTransport({ case_id, person_id, raw_text }) {
  const pre = await executeAgent("preprocessor", { text: raw_text });

  const doc = await storeDocument({
    case_id,
    person_id,
    file_path: null,
    source_system: "TRANSPORT",
    normalized_text: pre.normalized_text,
    document_type: "transport_log",
    origin_state: pre.origin_state,
    origin_county: pre.origin_county,
    needs_redaction: pre.needs_redaction
  });

  const flag = await executeAgent("flagging_agent", {
    case_id,
    person_id,
    normalized_text: pre.normalized_text
  });

  if (flag) {
    await writeFlag(flag);

    if (flag.severity === "critical") {
      await createEvent({
        case_id,
        person_id,
        event_type: "critical_transport_flag",
        event_date: new Date().toISOString(),
        description: flag.description,
        is_critical: true
      });
    }
  }

  return { document: doc, flag };
}
