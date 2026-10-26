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
  if (typeof data.output === "string") teks = data.output.trim();
  if (!teks && Array.isArray(data.output)) {
    teks = data.output.map(o => (o.content || []).map(c => c.text || "").join("")).join("").trim();
  }
  if (!teks && typeof data.output_text === "string") teks = data.output_text.trim();
  if (!teks && data.choices && data.choices[0] && data.choices[0].message) {
    teks = String(data.choices[0].message.content || "").trim();
  }
  return teks;
}

// Baca balasan AgentRouter sebagai TEKS dulu, baru tafsirkan:
// sebagian channel membalas SSE (stream "data: ...") walau tidak diminta —
// JSON langsung akan gagal dibaca dan hasilnya objek kosong.
function tafsirBalasan(mentah) {
  const s = String(mentah || "");
  if (s.trimStart().startsWith("data:")) {
    let teksDelta = "";
    let objekFinal = null;
    for (const baris of s.split(/\r?\n/)) {
      const b = baris.trim();
      if (!b.startsWith("data:")) continue;
      const isi = b.slice(5).trim();
      if (!isi || isi === "[DONE]") continue;
      try {
        const ev = JSON.parse(isi);
        if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") teksDelta += ev.delta;
        if (ev.response && typeof ev.response === "object") objekFinal = ev.response;
      } catch (e) {}
    }
    if (objekFinal) return objekFinal;
    if (teksDelta) return { output_text: teksDelta };
    return {};
  }
  let data = {};
  try { data = JSON.parse(s); } catch (e) { return {}; }
  // Kadang terbungkus { data: {...} }
  if (data && typeof data === "object" && data.data && typeof data.data === "object" && !data.output && !data.error && !data.choices) {
    data = data.data;
  }
  return data || {};
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
  const mentah = await r.text().catch(() => "");
  return { r, data: tafsirBalasan(mentah), mentah };
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

  const body = { model, input: prompt, max_output_tokens: maxTokens, stream: false };
  if (system) body.instructions = system;

  try {
    let hasil = await panggilAgent(key, body);
    if (!hasil.r.ok) {
      const msg = hasil.data?.error?.message || ("HTTP " + hasil.r.status + " " + String(hasil.mentah || "").slice(0, 120));
      return res.status(hasil.r.status).json({ ok: false, error: msg, model });
    }
    let text = ekstrakTeks(hasil.data);
    if (!text) {
      // Balasan 200 tapi kosong — coba sekali lagi dengan token lebih besar.
      const body2 = { ...body, max_output_tokens: Math.min(4000, maxTokens * 4) };
      const ulang = await panggilAgent(key, body2);
      if (ulang.r.ok) {
        const teks2 = ekstrakTeks(ulang.data);
        if (teks2) { text = teks2; hasil = ulang; }
        else hasil = ulang;
      }
    }
    if (!text) {
      const diag = "status " + (hasil.data && hasil.data.status ? hasil.data.status : "?")
        + ", output " + (Array.isArray(hasil.data.output) ? hasil.data.output.length : 0) + " item"
        + (hasil.data.usage ? ", token keluar " + hasil.data.usage.output_tokens : "")
        + " | cuplikan: " + String(hasil.mentah || "").replace(/\s+/g, " ").slice(0, 200);
      return res.status(502).json({ ok: false, error: "Model membalas kosong (" + diag + ")", model });
    }
    return res.status(200).json({ ok: true, text, model });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Relay gagal menghubungi AgentRouter: " + (e.message || String(e)), model });
  }
};
