import {
  judgeProfile,
  prosecutorProfile,
  allJudgeProfiles,
  allProsecutorProfiles
} from '../../backend/actor_profiles.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, id } = req.query;

  if (!type) {
    return res.status(400).json({
      error:     'type param is required',
      available: ['judge', 'prosecutor', 'judges', 'prosecutors']
    });
  }

  try {
    let result;

    switch (type) {
      case 'judge':
        if (!id) return res.status(400).json({ error: 'id is required for type=judge' });
        result = await judgeProfile(id);
        break;

      case 'prosecutor':
        if (!id) return res.status(400).json({ error: 'id is required for type=prosecutor' });
        result = await prosecutorProfile(id);
        break;

      case 'judges':
        result = await allJudgeProfiles();
        break;

      case 'prosecutors':
        result = await allProsecutorProfiles();
        break;

      default:
        return res.status(400).json({
          error:     `Unknown type "${type}"`,
          available: ['judge', 'prosecutor', 'judges', 'prosecutors']
        });
    }

    if (result?.error) return res.status(404).json({ error: result.error });
    return res.status(200).json({ type, ...result });
  } catch (err) {
    console.error(`Actor profiles error [${type}]:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
