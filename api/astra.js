// Relay AgentRouter (GPT Astra) untuk VanGPT.
// Kenapa perlu relay: AgentRouter menolak semua browser ("unauthorized client
// detected") dan hanya menerima klien agen tertentu — browser tidak bisa
// mengatur User-Agent, jadi VanGPT memanggil endpoint ini dan gateway
// meneruskan permintaan ke AgentRouter dengan identitas klien Cline.
//
// Pakai: POST /api/astra
// Header: x-agent-key: <API key AgentRouter> (atau set env AGENTROUTER_KEY)
// Body JSON: { prompt: "...", system: "referensi identitas", model: "gpt-6-astra" }
// Balasan: { ok: true, text: "...", model: "..." }
const AGENT_BASE = "https://agentrouter.org/v1";
const AGENT_UA = "Cline/3.32.0";
const MODELS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-6.1-sol"];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-agent-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const key = String(process.env.AGENTROUTER_KEY || req.headers["x-agent-key"] || "").trim();
  if (!key) return res.status(401).json({ ok: false, error: "Kunci AgentRouter belum ada — kirim header x-agent-key atau set env AGENTROUTER_KEY" });

  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ ok: false, error: "prompt wajib diisi" });
  const model = MODELS.includes(req.body?.model) ? req.body.model : MODELS[0];
  const system = String(req.body?.system || "").trim();
  const maxTokens = Math.min(2000, Math.max(64, Number(req.body?.maxTokens || 1000) || 1000));

  const body = { model, input: prompt, max_output_tokens: maxTokens };
  if (system) body.instructions = system;

  try {
    const r = await fetch(AGENT_BASE + "/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + key,
        "user-agent": AGENT_UA,
      },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || ("HTTP " + r.status);
      return res.status(r.status).json({ ok: false, error: msg, model });
    }
    let text = "";
    if (typeof data.output_text === "string") text = data.output_text;
    else if (Array.isArray(data.output)) {
      text = data.output.map(o => (o.content || []).map(c => c.text || "").join("")).join("").trim();
    }
    if (!text) text = "(Model membalas kosong — coba ulangi atau ganti model.)";
    return res.status(200).json({ ok: true, text, model });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Relay gagal menghubungi AgentRouter: " + (e.message || String(e)), model });
  }
};
