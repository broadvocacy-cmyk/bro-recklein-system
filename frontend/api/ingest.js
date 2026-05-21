import { ingest } from "../../backend/ingestion/router.js";
import { verifyIngestedDocument } from "../../backend/verification_agent.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { type, payload } = req.body;

  try {
    const result = await ingest(type, payload);

    // Fire-and-forget: verify citations, timeline, and actor identity on the
    // stored document without blocking the ingest response.
    const docId = result?.document?.data?.id;
    if (docId && payload?.case_id) {
      verifyIngestedDocument({ case_id: payload.case_id, document_id: docId })
        .catch(e => console.error('[verification] post-ingest error:', e.message));
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("Ingest error:", err);
    return res.status(500).json({ error: err.message });
  }
}
