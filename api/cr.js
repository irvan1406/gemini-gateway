// Relay Clash Royale API (resmi Supercell) untuk situs penampil pemain.
// Kenapa perlu relay: API Supercell mengunci key ke alamat IP yang
// didaftarkan, jadi browser tidak bisa memanggil langsung. Relay ini
// meneruskan permintaan ke proxy RoyaleAPI (proxy.royaleapi.dev) — key
// dibuat dengan Allowed IP 45.79.218.79 (IP proxy itu), jadi panggilan
// dari relay tetap diterima Supercell.
//
// Pakai: GET /api/cr?path=/players/%23TAG
//        GET /api/cr?path=/players/%23TAG/battlelog
//        GET /api/cr?path=/players/%23TAG/upcomingchests
//        GET /api/cr?path=/cards
// Key: env CR_API_KEY (atau header x-cr-key).
// Hanya path baca yang diizinkan yang diteruskan.
const CR_BASE = "https://proxy.royaleapi.dev/v1";
const AWALAN_SAH = ["/cards", "/players/", "/clans/"];

function pathSah(p) {
  if (typeof p !== "string") return false;
  if (!p.startsWith("/") || p.includes("..") || p.includes("\\")) return false;
  return AWALAN_SAH.some((a) => p === a || p.startsWith(a));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-cr-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const key = String(process.env.CR_API_KEY || req.headers["x-cr-key"] || "").trim();
  if (!key) return res.status(401).json({ ok: false, error: "Kunci Clash Royale belum dipasang — set env CR_API_KEY di Vercel" });

  const path = String(req.query?.path || "");
  if (!pathSah(path)) return res.status(400).json({ ok: false, error: "path tidak diizinkan" });

  try {
    const r = await fetch(CR_BASE + path, {
      headers: { "accept": "application/json", "authorization": "Bearer " + key },
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Relay gagal menghubungi API Clash Royale: " + (e.message || String(e)) });
  }
};
