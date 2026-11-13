// Grame の AI対戦モード用プロキシ。APIキーはサーバーの環境変数からのみ読む。
// 環境変数（Vercel: Project → Settings → Environment Variables）:
//   GRAME_API_KEY   必須。Groq などの OpenAI 互換 API キー
//   GRAME_API_BASE  任意。既定 https://api.groq.com/openai/v1
//   GRAME_MODEL     任意。既定 qwen/qwen3.8-27b

function stripThinkTags(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'リクエストJSONが不正です' });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages は空でない配列である必要があります' });
  }

  const temperature = typeof body.temperature === 'number'
    ? Math.max(0, Math.min(1.5, body.temperature))
    : 0.3;

  try {
    const upstream = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: body.messages,
      }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
    });

    const rawText = await upstream.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      return res.status(upstream.ok ? 502 : upstream.status).json({
        error: `上流APIがJSON以外を返しました (${upstream.status})`,
      });
    }

    if (!upstream.ok) {
      const msg = (data && data.error && (data.error.message || data.error)) || `APIエラー (${upstream.status})`;
      return res.status(upstream.status).json({ error: String(msg) });
    }

    if (data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message) {
      data.choices[0].message.content = stripThinkTags(data.choices[0].message.content);
    }

    return res.status(200).json(data);
  } catch (e) {
    const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? 'AI応答がタイムアウトしました' : ('upstream error: ' + String((e && e.message) || e)),
    });
  }
};
