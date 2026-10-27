// Relay WFLabs untuk VanGPT.
// Kenapa perlu relay: api.wflabs.ai.id tidak mengirim header CORS, jadi
// browser memblokir panggilan langsung dari halaman VanGPT. Gateway
// meneruskan permintaan ke WFLabs (endpoint OpenAI standar).
//
// Pakai: POST /api/wf
// Header: x-wf-key: <API key WFLabs> (atau set env WF_API_KEY)
// Body JSON: { prompt, system, model, history: [{role, text}], image: "data:image/..." }
// history = riwayat percakapan room aktif (memori per sesi), image = lampiran
// gambar pesan terakhir (vision). Hanya model yang TERBUKTI bisa dipakai
// (gratis) yang diterima. Balasan: { ok: true, text: "...", model: "..." }
const WF_BASE = "https://api.wflabs.ai.id/v1";
const WF_MODELS = [
  "wf/deepseek-v4.1-flash",
  "wf/deepseek-v4.1-flash-1017",
  "wf/glm-5.3-flash",
  "wf/nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4",
];

function saringRiwayat(raw) {
  if (!Array.isArray(raw)) return [];
  const bersih = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" || m.role === "ai" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) continue;
    const text = String(m.text || m.content || "").trim().slice(0, 4000);
    if (!text) continue;
    bersih.push({ role, content: text });
  }
  return bersih.slice(-16);
}

function gambarSah(s) {
  return typeof s === "string" && s.startsWith("data:image/") && s.length <= 2800000;
}

async function panggilWf(key, model, system, riwayat, prompt, gambar, maxTokens) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  for (const m of riwayat) messages.push(m);
  if (gambar) {
    messages.push({ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: gambar } },
    ] });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  const r = await fetch(WF_BASE + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer " + key },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(28000),
  });
  const data = await r.json().catch(() => ({}));
  return { r, data };
}

function ekstrak(data) {
  const msg = data && data.choices && data.choices[0] ? data.choices[0].message : null;
  return msg ? String(msg.content || "").trim() : "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-wf-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const key = String(process.env.WF_API_KEY || req.headers["x-wf-key"] || "").trim();
  if (!key) return res.status(401).json({ ok: false, error: "Kunci WFLabs belum ada — kirim header x-wf-key atau set env WF_API_KEY" });

  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ ok: false, error: "prompt wajib diisi" });
  const model = WF_MODELS.includes(req.body?.model) ? req.body.model : WF_MODELS[0];
  const system = String(req.body?.system || "").trim();
  const riwayat = saringRiwayat(req.body?.history);
  const gambar = gambarSah(req.body?.image) ? req.body.image : null;

  try {
    let { r, data } = await panggilWf(key, model, system, riwayat, prompt, gambar, 2000);
    if (!r.ok) {
      const msg = data?.error?.message || ("HTTP " + r.status);
      return res.status(r.status).json({ ok: false, error: msg, model });
    }
    let text = ekstrak(data);
    if (!text) {
      // Model reasoning kadang menghabiskan token untuk berpikir — ulangi lebih besar.
      const ulang = await panggilWf(key, model, system, riwayat, prompt, gambar, 4000);
      if (ulang.r.ok) {
        const t2 = ekstrak(ulang.data);
        if (t2) text = t2;
      }
    }
    if (!text) return res.status(502).json({ ok: false, error: "Model WFLabs membalas kosong — coba ulangi atau ganti model.", model });
    return res.status(200).json({ ok: true, text, model });
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Relay gagal menghubungi WFLabs: " + (e.message || String(e)), model });
  }
};
