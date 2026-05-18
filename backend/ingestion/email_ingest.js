import { executeAgent } from "../agent_executor.js";
import { storeDocument } from "../documents.js";
import { writeFlag } from "../flags.js";
import { createEvent } from "../events.js";

export async function ingestEmail({ case_id, person_id, subject, body }) {
  const pre = await executeAgent("preprocessor", { text: body });

  const doc = await storeDocument({
    case_id,
    person_id,
    file_path: null,
    source_system: "EMAIL",
    normalized_text: pre.normalized_text,
    document_type: "email",
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
        event_type: "critical_email_flag",
        event_date: new Date().toISOString(),
        description: flag.description,
        is_critical: true
      });
    }
  }

  return { document: doc, flag };
}
