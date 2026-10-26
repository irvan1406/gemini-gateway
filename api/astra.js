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

// Ekstraksi teks yang tahan variasi bentuk balasan antar-channel AgentRouter:
// teks asli bisa di output[].content[].text, di output_text, atau ala chat.
// PENTING: output_text kadang hadir sebagai string KOSONG padahal teksnya ada
// di output[] — jadi output[] selalu diperiksa lebih dulu.
function ekstrakTeks(data) {
  let teks = "";
  if (Array.isArray(data.output)) {
    teks = data.output.map(o => (o.content || []).map(c => c.text || "").join("")).join("").trim();
  }
  if (!teks && typeof data.output_text === "string") teks = data.output_text.trim();
  if (!teks && data.choices && data.choices[0] && data.choices[0].message) {
    teks = String(data.choices[0].message.content || "").trim();
  }
  return teks;
}

async function panggilAgent(key, body) {
  const r = await fetch(AGENT_BASE + "/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + key,
      "user-agent": AGENT_UA,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

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
    let { r, data } = await panggilAgent(key, body);
    if (!r.ok) {
      const msg = data?.error?.message || ("HTTP " + r.status);
      return res.status(r.status).json({ ok: false, error: msg, model });
    }
    let text = ekstrakTeks(data);
    if (!text) {
      // Balasan 200 tapi kosong (biasanya token habis untuk reasoning) —
      // coba sekali lagi dengan anggaran token lebih besar.
      const body2 = { ...body, max_output_tokens: Math.min(4000, maxTokens * 4) };
      const ulang = await panggilAgent(key, body2);
      if (ulang.r.ok) {
        const teks2 = ekstrakTeks(ulang.data);
        if (teks2) { text = teks2; data = ulang.data; }
        else data = ulang.data;
      }
    }
    if (!text) {
      const diag = "status " + (data && data.status ? data.status : "?")
        + ", output " + (Array.isArray(data.output) ? data.output.length : 0) + " item"
        + (data.usage ? ", token keluar " + data.usage.output_tokens : "");
      return res.status(502).json({ ok: false, error: "Model membalas kosong (" + diag + ") — coba ulangi atau ganti model.", model });
    }
    return res.status(200).json({ ok: true, text, model });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Relay gagal menghubungi AgentRouter: " + (e.message || String(e)), model });
  }
};
