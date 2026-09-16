const cooldowns = new Map();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const DEFAULT_COOLDOWN = Math.max(10, Number(process.env.KEY_COOLDOWN_SECONDS || 60));

function getKeys() {
  const keys = [];
  for (let i = 1; i <= 20; i++) {
    const k = String(process.env[`GEMINI_API_KEY_${i}`] || "").trim();
    if (k) keys.push({ number: i, key: k });
  }
  // Backward compatibility
  const single = String(process.env.GEMINI_API_KEY || "").trim();
  if (single && !keys.some(x => x.key === single)) keys.push({ number: 0, key: single });
  return keys;
}

function bearer(req) {
  const h = String(req.headers.authorization || "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function retrySeconds(text) {
  const m = String(text || "").match(/retry(?:\s+in|\s+after)?\s*([0-9.]+)\s*s/i);
  return m ? Math.max(1, Math.ceil(Number(m[1]))) : DEFAULT_COOLDOWN;
}

function isRetryable(status, text) {
  const s = String(text || "").toLowerCase();
  return status === 429 ||
    status === 503 ||
    status === 500 ||
    s.includes("quota") ||
    s.includes("rate limit") ||
    s.includes("resource_exhausted") ||
    s.includes("temporarily unavailable");
}

function extractText(data) {
  return data?.candidates?.[0]?.content?.parts
    ?.map(p => p?.text || "")
    .join("")
    .trim() || "";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Gunakan POST /api/generate" });
  }

  if (!GATEWAY_TOKEN || bearer(req) !== GATEWAY_TOKEN) {
    return res.status(401).json({ ok: false, error: "Gateway token tidak valid." });
  }

  const keys = getKeys();
  if (!keys.length) {
    return res.status(500).json({ ok: false, error: "GEMINI_API_KEY_1 belum diatur di Vercel." });
  }

  const body = req.body || {};
  const prompt = String(body.prompt || body.text || "").trim();
  const system = String(body.system || body.systemPrompt || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];

  if (!prompt) return res.status(400).json({ ok: false, error: "Prompt kosong." });

  // Preserve conversation history if bot sends it.
  const contents = [];
  for (const item of history.slice(-20)) {
    const role = item?.role === "assistant" || item?.role === "model" ? "model" : "user";
    const text = String(item?.content ?? item?.text ?? "").trim();
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const payload = {
    contents,
    generationConfig: body.generationConfig || {
      temperature: 0.35,
      maxOutputTokens: 2048
    }
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  const now = Date.now();
  const available = keys.filter(x => (cooldowns.get(x.key) || 0) <= now);
  const candidates = available.length ? available : keys;

  let lastError = "Semua Gemini API key gagal.";
  let shortestWait = null;
  let attempted = 0;

  for (const item of candidates) {
    const until = cooldowns.get(item.key) || 0;
    if (until > Date.now()) {
      const wait = Math.ceil((until - Date.now()) / 1000);
      shortestWait = shortestWait == null ? wait : Math.min(shortestWait, wait);
      continue;
    }

    attempted++;
    try {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(item.key)}`;

      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }

      if (r.ok) {
        cooldowns.delete(item.key);
        const text = extractText(data);
        if (!text) {
          lastError = `Key #${item.number || 1}: Gemini tidak mengembalikan teks.`;
          continue;
        }
        return res.status(200).json({
          ok: true,
          text,
          model: MODEL,
          keyIndex: item.number || 1
        });
      }

      const message = data?.error?.message || raw || `HTTP ${r.status}`;
      lastError = message;

      if (isRetryable(r.status, message)) {
        const sec = retrySeconds(message);
        cooldowns.set(item.key, Date.now() + sec * 1000);
        shortestWait = shortestWait == null ? sec : Math.min(shortestWait, sec);
        // IMPORTANT: immediately try next key.
        continue;
      }

      // Invalid/blocked key: cool it longer and try the next one.
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        cooldowns.set(item.key, Date.now() + 10 * 60 * 1000);
        continue;
      }
    } catch (e) {
      lastError = e?.message || String(e);
      cooldowns.set(item.key, Date.now() + 15 * 1000);
      shortestWait = shortestWait == null ? 15 : Math.min(shortestWait, 15);
    }
  }

  // If all keys were already cooling down.
  if (!attempted) {
    for (const item of keys) {
      const until = cooldowns.get(item.key) || 0;
      if (until > Date.now()) {
        const wait = Math.ceil((until - Date.now()) / 1000);
        shortestWait = shortestWait == null ? wait : Math.min(shortestWait, wait);
      }
    }
  }

  return res.status(429).json({
    ok: false,
    error: "Semua jalur Gemini sedang mencapai batas sementara.",
    retryAfter: shortestWait || DEFAULT_COOLDOWN,
    detail: lastError,
    model: MODEL
  });
};
