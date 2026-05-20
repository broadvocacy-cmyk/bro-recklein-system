import {
  generateCasePacket,
  generateFOIABundle,
  generateFlagBundle,
  generateActorProfileExport,
  generateStrategyBrief
} from '../../backend/exports.js';

const TYPES = ['case_packet', 'foia_bundle', 'flag_bundle', 'actor_profile', 'strategy_brief'];
const FORMATS = ['json', 'markdown'];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, format = 'json', download, case_id, person_id, role } = req.query;

  if (!type) {
    return res.status(400).json({ error: 'type is required', available: TYPES });
  }
  if (!FORMATS.includes(format)) {
    return res.status(400).json({ error: `format must be one of: ${FORMATS.join(', ')}` });
  }

  try {
    let result;

    switch (type) {
      case 'case_packet':
        if (!case_id) return res.status(400).json({ error: 'case_id is required' });
        result = await generateCasePacket(case_id, format);
        break;

      case 'foia_bundle':
        if (!case_id) return res.status(400).json({ error: 'case_id is required' });
        result = await generateFOIABundle(case_id, format);
        break;

      case 'flag_bundle':
        if (!case_id) return res.status(400).json({ error: 'case_id is required' });
        result = await generateFlagBundle(case_id, format);
        break;

      case 'actor_profile':
        if (!person_id) return res.status(400).json({ error: 'person_id is required' });
        if (!role || !['judge', 'prosecutor'].includes(role)) {
          return res.status(400).json({ error: 'role must be "judge" or "prosecutor"' });
        }
        result = await generateActorProfileExport(person_id, role, format);
        break;

      case 'strategy_brief':
        if (!case_id) return res.status(400).json({ error: 'case_id is required' });
        result = await generateStrategyBrief(case_id);
        break;

      default:
        return res.status(400).json({ error: `Unknown type "${type}"`, available: TYPES });
    }

    if (result?.error) return res.status(404).json({ error: result.error });

    // Serve as downloadable file when download=true and content is markdown
    if (download === 'true' && result.content) {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.status(200).send(result.content);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error(`Export error [${type}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
