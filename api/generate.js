const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TOKEN = String(process.env.GATEWAY_TOKEN || "").trim();
const COOLDOWN_MS = Number(process.env.KEY_COOLDOWN_SECONDS || 60) * 1000;

const state = globalThis.__geminiGatewayState || (globalThis.__geminiGatewayState = {
  active: 0,
  cooldown: {}
});

function getKeys() {
  return Object.entries(process.env)
    .filter(([k,v]) => /^GEMINI_API_KEY_\d+$/.test(k) && String(v || "").trim())
    .sort((a,b) => Number(a[0].match(/\d+/)[0]) - Number(b[0].match(/\d+/)[0]))
    .map(([name,value]) => ({name, value:String(value).trim()}));
}

function authorized(req) {
  return TOKEN && String(req.headers.authorization || "") === `Bearer ${TOKEN}`;
}

function quotaError(status, msg) {
  return status === 429 || /quota|rate.?limit|resource_exhausted/i.test(msg || "");
}

function locationError(msg) {
  return /location is not supported|user location is not supported/i.test(msg || "");
}

function makePayload(body={}) {
  if (Array.isArray(body.contents)) {
    const out = {contents: body.contents};
    if (body.systemInstruction) out.systemInstruction = body.systemInstruction;
    if (body.generationConfig) out.generationConfig = body.generationConfig;
    return out;
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("Field 'prompt' wajib diisi.");
  const parts = [];
  if (body.system) parts.push(`INSTRUKSI SISTEM:\n${body.system}`);
  if (body.context) parts.push(`KONTEKS BOT:\n${body.context}`);
  parts.push(`PERTANYAAN/PERINTAH USER:\n${body.prompt}`);
  return {
    contents:[{role:"user",parts:[{text:parts.join("\n\n")}]}],
    generationConfig:{
      temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.2,
      maxOutputTokens: Number(body.maxOutputTokens || 2048)
    }
  };
}

function textFrom(data) {
  return (data?.candidates?.[0]?.content?.parts || []).map(x => x?.text || "").join("").trim();
}

module.exports = async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  if (req.method !== "POST") return res.status(405).json({ok:false,error:"Gunakan POST"});
  if (!authorized(req)) return res.status(401).json({ok:false,error:"Unauthorized"});

  const keys = getKeys();
  if (!keys.length) return res.status(500).json({ok:false,error:"GEMINI_API_KEY_1 belum diisi di Vercel"});
  let payload;
  try { payload = makePayload(req.body || {}); }
  catch(e) { return res.status(400).json({ok:false,error:e.message}); }

  const order = keys.map((_,i)=>(state.active+i)%keys.length);
  let last = {status:502,msg:"Gemini gagal"};

  for (const idx of order) {
    if ((state.cooldown[idx] || 0) > Date.now()) continue;
    const key = keys[idx].value;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const data = await r.json().catch(()=>({}));
      if (r.ok) {
        state.active = idx;
        return res.status(200).json({ok:true,provider:"gemini",model:MODEL,keyNumber:idx+1,text:textFrom(data)});
      }
      const msg = data?.error?.message || `HTTP ${r.status}`;
      last = {status:r.status,msg};
      if (quotaError(r.status,msg)) {
        state.cooldown[idx] = Date.now()+COOLDOWN_MS;
        continue;
      }
      if (locationError(msg)) {
        return res.status(r.status || 403).json({ok:false,error:msg,locationError:true});
      }
      if ([400,401,403].includes(r.status)) continue;
      break;
    } catch(e) {
      last = {status:502,msg:e.message};
    }
  }
  return res.status(last.status || 502).json({ok:false,error:last.msg});
}
