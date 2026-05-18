import { generateMorningBrief } from "../../backend/morning_brief.js";

export default async function handler(req, res) {
  const person_id = process.env.PRIMARY_PERSON_ID;

  try {
    const brief = await generateMorningBrief(person_id);
    return res.status(200).json(brief);
  } catch (err) {
    console.error("Morning brief error:", err);
    return res.status(500).json({ error: err.message });
  }
}
