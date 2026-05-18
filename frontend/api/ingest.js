import { ingest } from "../../backend/ingestion/router.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { type, payload } = req.body;

  try {
    const result = await ingest(type, payload);
    return res.status(200).json(result);
  } catch (err) {
    console.error("Ingest error:", err);
    return res.status(500).json({ error: err.message });
  }
}
