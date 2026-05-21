import {
  createFOIARequest,
  updateFOIARequest,
  getFOIARequestsByCase,
  getOverdueFOIARequests
} from '../../backend/foia_requests.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { data, error } = await createFOIARequest(req.body);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(201).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    const { id, ...fields } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      const { data, error } = await updateFOIARequest(id, fields);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'GET') {
    const { case_id, overdue } = req.query;
    try {
      let result;
      if (overdue === 'true') {
        result = await getOverdueFOIARequests();
      } else if (case_id) {
        result = await getFOIARequestsByCase(case_id);
      } else {
        return res.status(400).json({ error: 'case_id or overdue=true is required' });
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json(result.data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
