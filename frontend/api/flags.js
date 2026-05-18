import { supabase } from "../../backend/supabase_client.js";

export default async function handler(req, res) {
  const { data, error } = await supabase
    .from("flags")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(data);
}
