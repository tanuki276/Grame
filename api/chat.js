// Grame の AI対戦モード用プロキシ。APIキーはサーバーの環境変数からのみ読む。
// 環境変数（Vercel: Project → Settings → Environment Variables）:
//   GRAME_API_KEY   必須。Groq などの OpenAI 互換 API キー
//   GRAME_API_BASE  任意。既定 https://api.groq.com/openai/v1
//   GRAME_MODEL     任意。既定 qwen/qwen3.8-27b
module.exports = async function handler(req, res) {
  const key = process.env.GRAME_API_KEY || '';
  const base = (process.env.GRAME_API_BASE || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const model = process.env.GRAME_MODEL || 'qwen/qwen3.8-27b';

  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!key, model, base });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!key) {
    return res.status(501).json({ error: '環境変数 GRAME_API_KEY が未設定です' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
        messages: body.messages || [],
      }),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'upstream error: ' + String(e && e.message || e) });
  }
};
