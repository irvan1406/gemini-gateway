const cooldowns = new Map();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const DEFAULT_COOLDOWN = Math.max(10, Number(process.env.KEY_COOLDOWN_SECONDS || 60));
function getKeys(){const a=[];for(let i=1;i<=20;i++){const k=String(process.env[`GEMINI_API_KEY_${i}`]||"").trim();if(k)a.push({number:i,key:k})}const one=String(process.env.GEMINI_API_KEY||"").trim();if(one&&!a.some(x=>x.key===one))a.push({number:0,key:one});return a}
function bearer(req){const h=String(req.headers.authorization||"");return h.startsWith("Bearer ")?h.slice(7).trim():""}
function retrySeconds(t){const m=String(t||"").match(/retry(?:\s+in|\s+after)?\s*([0-9.]+)\s*s/i);return m?Math.max(1,Math.ceil(Number(m[1]))):DEFAULT_COOLDOWN}
function retryable(s,t){t=String(t||"").toLowerCase();return s===429||s===503||s===500||t.includes("quota")||t.includes("rate limit")||t.includes("resource_exhausted")||t.includes("temporarily unavailable")}
function extractText(d){return d?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("").trim()||""}
function statusPayload(){const now=Date.now(),keys=getKeys();return {ok:true,model:MODEL,keyCount:keys.length,keys:keys.map((x,i)=>{const until=cooldowns.get(x.key)||0;return {index:i+1,number:x.number,status:until>now?"cooldown":"ready",retryAfter:until>now?Math.ceil((until-now)/1000):0}})}}
module.exports=async function handler(req,res){
 if(GATEWAY_TOKEN&&bearer(req)!==GATEWAY_TOKEN)return res.status(401).json({ok:false,error:"Unauthorized"});
 if(req.method==="GET")return res.status(200).json(statusPayload());
 if(req.method!=="POST")return res.status(405).json({ok:false,error:"Method not allowed"});
 const keys=getKeys();if(!keys.length)return res.status(500).json({ok:false,error:"Gemini API key belum dikonfigurasi",...statusPayload()});
 const prompt=String(req.body?.prompt||"").trim();if(!prompt)return res.status(400).json({ok:false,error:"prompt wajib diisi"});
 const system=String(req.body?.system||req.body?.systemPrompt||"").trim();const hist=Array.isArray(req.body?.history)?req.body.history.slice(-20):[];
 const contents=[];for(const h of hist){const role=h.role==="assistant"||h.role==="model"?"model":"user";const text=String(h.text||h.content||"").trim();if(text)contents.push({role,parts:[{text}]})}contents.push({role:"user",parts:[{text:prompt}]});
 let lastError="",shortest=null,attempted=0;
 for(let i=0;i<keys.length;i++){const x=keys[i],now=Date.now(),until=cooldowns.get(x.key)||0;if(until>now){const r=Math.ceil((until-now)/1000);shortest=shortest==null?r:Math.min(shortest,r);continue}attempted++;
  try{const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(x.key)}`;const body={contents,generationConfig:{temperature:.45,maxOutputTokens:1800}};if(system)body.systemInstruction={parts:[{text:system}]};const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(r.ok){cooldowns.delete(x.key);return res.status(200).json({ok:true,text:extractText(data),model:MODEL,keyIndex:i+1,keyCount:keys.length})}lastError=data?.error?.message||`HTTP ${r.status}`;let wait=retrySeconds(lastError);if(r.status===400||r.status===401||r.status===403)wait=Math.max(wait,600);if(retryable(r.status,lastError)||[400,401,403].includes(r.status)){cooldowns.set(x.key,Date.now()+wait*1000);shortest=shortest==null?wait:Math.min(shortest,wait);continue}return res.status(r.status).json({ok:false,error:lastError,model:MODEL,keyCount:keys.length})}catch(e){lastError=e.message||String(e);const wait=DEFAULT_COOLDOWN;cooldowns.set(x.key,Date.now()+wait*1000);shortest=shortest==null?wait:Math.min(shortest,wait)}}
 return res.status(429).json({ok:false,error:"Semua jalur Gemini sedang mencapai batas sementara.",retryAfter:shortest||DEFAULT_COOLDOWN,detail:lastError,model:MODEL,keyCount:keys.length,attempted});
}
