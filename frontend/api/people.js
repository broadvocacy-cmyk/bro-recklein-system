import {
  createPerson,
  updatePerson,
  deletePerson,
  getPeopleByCase,
  getPeopleByRole,
  searchPeople,
  linkPersonToCase
} from '../../backend/people.js';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { link_to_case, person_id, case_id, ...personFields } = req.body;

    if (link_to_case) {
      if (!person_id || !case_id) {
        return res.status(400).json({ error: 'person_id and case_id are required for link_to_case' });
      }
      try {
        const { data, error } = await linkPersonToCase(person_id, case_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    try {
      const { data, error } = await createPerson(personFields);
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
      const { data, error } = await updatePerson(id, fields);
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
      const { error } = await deletePerson(id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(204).end();
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'GET') {
    const { case_id, role, q } = req.query;
    try {
      let result;
      if (q) {
        result = await searchPeople(q);
      } else if (case_id && role) {
        result = await getPeopleByRole(case_id, role);
      } else if (case_id) {
        result = await getPeopleByCase(case_id);
      } else {
        return res.status(400).json({ error: 'case_id or q is required' });
      }
      if (result.error) return res.status(500).json({ error: result.error.message });
      return res.status(200).json(result.data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
