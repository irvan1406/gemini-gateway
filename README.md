# Gemini Gateway — Vercel

Jangan simpan API key di GitHub.

Environment Variables di Vercel:
- `GATEWAY_TOKEN` = token rahasia panjang buatan sendiri
- `GEMINI_MODEL` = `gemini-2.5-flash`
- `GEMINI_API_KEY_1` = API key pertama
- `GEMINI_API_KEY_2` ... `_5` = opsional
- `KEY_COOLDOWN_SECONDS` = `60`

Endpoint setelah deploy:
- `POST /api/generate`
- `GET /api/health` (Bearer token diperlukan)

Bot Pterodactyl nantinya menggunakan:
`AI_GATEWAY_URL=https://DOMAIN-VERCEL/api/generate`
dan `AI_GATEWAY_TOKEN=...`
