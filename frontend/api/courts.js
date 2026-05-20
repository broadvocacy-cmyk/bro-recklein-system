import {
  createCourt,
  updateCourt,
  deleteCourt,
  getCourtsByCase,
  getCourtsByState,
  searchCourts,
  assignJudge,
  linkCourtToCase
} from '../../backend/courts.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { assign_judge, link_to_case, court_id, judge_id, case_id, ...courtFields } = req.body;

    if (assign_judge) {
      if (!court_id || !judge_id) {
        return res.status(400).json({ error: 'court_id and judge_id are required for assign_judge' });
      }
      try {
        const { data, error } = await assignJudge(court_id, judge_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (link_to_case) {
      if (!court_id || !case_id) {
        return res.status(400).json({ error: 'court_id and case_id are required for link_to_case' });
      }
      try {
        const { data, error } = await linkCourtToCase(court_id, case_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    try {
      const { data, error } = await createCourt(courtFields);
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
      const { data, error } = await updateCourt(id, fields);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    const id = req.body?.id || req.query?.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      const { error } = await deleteCourt(id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(204).end();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'GET') {
    const { case_id, state, q } = req.query;
    try {
      let result;
      if (q) {
        result = await searchCourts(q);
      } else if (state && !case_id) {
        result = await getCourtsByState(state);
      } else if (case_id) {
        result = await getCourtsByCase(case_id);
      } else {
        return res.status(400).json({ error: 'case_id, state, or q is required' });
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json(result.data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
