import { createNote, getNotesByCase, getNotesByFlag, getNotesByType } from '../../backend/notes.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { data, error } = await createNote(req.body);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'GET') {
    const { case_id, flag_id, note_type } = req.query;

    try {
      let result;
      if (flag_id) {
        result = await getNotesByFlag(flag_id);
      } else if (note_type && case_id) {
        result = await getNotesByType(case_id, note_type);
      } else if (case_id) {
        result = await getNotesByCase(case_id);
      } else {
        return res.status(400).json({ error: 'case_id is required' });
      }

      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json(result.data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
