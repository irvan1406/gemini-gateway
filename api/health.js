module.exports = async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  const token = String(process.env.GATEWAY_TOKEN || "").trim();
  if (!token || String(req.headers.authorization || "") !== `Bearer ${token}`)
    return res.status(401).json({ok:false,error:"Unauthorized"});
  const keys = Object.entries(process.env)
    .filter(([k,v]) => /^GEMINI_API_KEY_\d+$/.test(k) && String(v || "").trim());
  return res.status(200).json({
    ok:true,
    service:"Gemini Gateway IRVANBOT",
    model:process.env.GEMINI_MODEL || "gemini-2.5-flash",
    keyCount:keys.length
  });
}
