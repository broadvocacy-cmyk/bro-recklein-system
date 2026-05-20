import {
  searchAll,
  searchCases,
  searchNotes,
  searchDocuments,
  searchFOIA,
  searchFlags,
  searchPeople
} from '../../backend/search.js';

const ENTITY_MAP = {
  case:         searchCases,
  note:         searchNotes,
  document:     searchDocuments,
  foia_request: searchFOIA,
  flag:         searchFlags,
  person:       searchPeople
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { q, entity, case_id, limit } = req.query;

  if (!q || q.trim().length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters' });
  }

  const opts = {
    case_id: case_id || undefined,
    limit:   limit ? Math.min(parseInt(limit, 10), 100) : undefined
  };

  try {
    let result;
    if (entity && ENTITY_MAP[entity]) {
      result = await ENTITY_MAP[entity](q.trim(), opts);
    } else if (entity) {
      return res.status(400).json({
        error: `Unknown entity "${entity}". Valid values: ${Object.keys(ENTITY_MAP).join(', ')}`
      });
    } else {
      result = await searchAll(q.trim(), opts);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('Search error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
