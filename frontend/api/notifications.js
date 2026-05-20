import {
  generateAll,
  getPendingNotifications,
  markRead,
  dismiss,
  dismissAllForCase
} from '../../backend/notifications.js';

export default async function handler(req, res) {
  // GET /api/notifications
  // ?case_id=   scope to one case
  // ?include_read=true  include already-read notifications
  if (req.method === 'GET') {
    const { case_id, include_read } = req.query;
    try {
      const result = await getPendingNotifications({
        case_id:      case_id || undefined,
        include_read: include_read === 'true'
      });
      if (result.error) return res.status(500).json({ error: result.error });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST /api/notifications  { action: 'generate' }
  if (req.method === 'POST') {
    const { action } = req.body ?? {};
    if (action !== 'generate') {
      return res.status(400).json({ error: 'action must be "generate"' });
    }
    try {
      const result = await generateAll();
      if (result.error) return res.status(500).json({ error: result.error });
      return res.status(200).json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // PATCH /api/notifications  { id, action: 'read' | 'dismiss' | 'dismiss_case', case_id? }
  if (req.method === 'PATCH') {
    const { id, action, case_id } = req.body ?? {};

    if (action === 'dismiss_case') {
      if (!case_id) return res.status(400).json({ error: 'case_id is required for dismiss_case' });
      try {
        const { error } = await dismissAllForCase(case_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ dismissed: true, case_id });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    if (!id) return res.status(400).json({ error: 'id is required' });
    if (!['read', 'dismiss'].includes(action)) {
      return res.status(400).json({ error: 'action must be "read" or "dismiss"' });
    }

    try {
      const fn = action === 'read' ? markRead : dismiss;
      const { data, error } = await fn(id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
