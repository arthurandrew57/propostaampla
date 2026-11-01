const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BASE64_CHARS = 3_000_000;
const requestTimes = globalThis.__amplaGeminiRequestTimes || (globalThis.__amplaGeminiRequestTimes = new Map());

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Basic same-site guard. The API key never reaches the browser.
  const origin = req.headers.origin;
  const host = req.headers.host || '';
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: 'origin_not_allowed' }); }
    const allowed = originHost === host || originHost === 'propostatryp.vercel.app' || /^propostatryp-[a-z0-9-]+\.vercel\.app$/i.test(originHost);
    if (!allowed) return res.status(403).json({ error: 'origin_not_allowed' });
  }

  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const recent = (requestTimes.get(ip) || []).filter(time => now - time < 60 * 60 * 1000);
  if (recent.length >= 40) return res.status(429).json({ error: 'quota_exceeded', message: 'Limite local de segurança atingido. Tente novamente mais tarde.' });
  recent.push(now);
  requestTimes.set(ip, recent);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'gemini_not_configured', message: 'Configure GEMINI_API_KEY nas variáveis de ambiente da Vercel.' });

  const { fileName, mimeType, data } = req.body || {};
  if (typeof data !== 'string' || data.length < 32 || data.length > MAX_BASE64_CHARS) {
    return res.status(413).json({ error: 'file_too_large', message: 'Arquivo muito grande para esta rota. Envie imagem comprimida ou PDF menor que aproximadamente 2 MB.' });
  }
  if (!ALLOWED_MIME.has(mimeType)) return res.status(415).json({ error: 'unsupported_type' });

  const safeName = String(fileName || 'documento').replace(/[\r\n"<>]/g, '').slice(0, 120);
  const prompt = `Você é um leitor de documentos brasileiros. Analise o arquivo anexado e extraia apenas informações que estejam visíveis. NÃO adivinhe, NÃO complete pelo contexto e NÃO corrija silenciosamente números. Se houver dúvida entre caracteres, valor ausente, ilegível ou documento que não contenha o campo, use value=null e confidence="low". Preserve exatamente o texto da evidência; normalize datas para AAAA-MM-DD somente quando a data estiver legível. Para CPF/CNPJ preserve os dígitos reconhecidos. Separe endereço residencial/do representante de endereço/sede da empresa somente se o documento deixar isso claro.\n\nResponda SOMENTE JSON válido, sem markdown, neste formato: {"fields":{"investorName":{"value":string|null,"confidence":"high|medium|low","evidence":string},"client":{"value":string|null,"confidence":"high|medium|low","evidence":string},"email":{"value":string|null,"confidence":"high|medium|low","evidence":string},"phone":{"value":string|null,"confidence":"high|medium|low","evidence":string},"marital":{"value":string|null,"confidence":"high|medium|low","evidence":string},"rg":{"value":string|null,"confidence":"high|medium|low","evidence":string},"cpf":{"value":string|null,"confidence":"high|medium|low","evidence":string},"profession":{"value":string|null,"confidence":"high|medium|low","evidence":string},"cnpj":{"value":string|null,"confidence":"high|medium|low","evidence":string},"birthDate":{"value":string|null,"confidence":"high|medium|low","evidence":string},"personZip":{"value":string|null,"confidence":"high|medium|low","evidence":string},"personAddress":{"value":string|null,"confidence":"high|medium|low","evidence":string},"hqZip":{"value":string|null,"confidence":"high|medium|low","evidence":string},"hqCity":{"value":string|null,"confidence":"high|medium|low","evidence":string},"hqAddress":{"value":string|null,"confidence":"high|medium|low","evidence":string}},"recognizedText":string}. Para cada valor, inclua em evidence um trecho curto e literal que sustente a leitura. Nome do arquivo: ${safeName}.`;

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 3500 }
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = response.status === 429 ? 'quota_exceeded' : response.status === 403 ? 'gemini_access_denied' : 'gemini_request_failed';
      return res.status(response.status === 429 ? 429 : 502).json({ error: code, message: payload.error?.message || 'O Gemini não conseguiu analisar o arquivo.' });
    }

    const text = (payload.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('').trim();
    if (!text) return res.status(502).json({ error: 'empty_response', message: 'O Gemini não retornou texto legível para este arquivo.' });
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let analysis;
    try { analysis = JSON.parse(cleaned); }
    catch { return res.status(502).json({ error: 'invalid_json', message: 'Resposta de leitura inválida; tente novamente ou confira o documento manualmente.' }); }

    // Return only the structured fields expected by the form. Do not log or store document data.
    const allowedFields = ['investorName', 'client', 'email', 'phone', 'marital', 'rg', 'cpf', 'profession', 'cnpj', 'birthDate', 'personZip', 'personAddress', 'hqZip', 'hqCity', 'hqAddress'];
    const fields = {};
    for (const key of allowedFields) {
      const item = analysis.fields?.[key] || {};
      fields[key] = {
        value: typeof item.value === 'string' ? item.value.trim().slice(0, 500) : null,
        confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'low',
        evidence: typeof item.evidence === 'string' ? item.evidence.slice(0, 240) : ''
      };
    }
    return res.status(200).json({ fields, recognizedText: typeof analysis.recognizedText === 'string' ? analysis.recognizedText.slice(0, 12000) : '' });
  } catch (error) {
    return res.status(502).json({ error: 'upstream_unavailable', message: 'Não foi possível acessar o Gemini agora. Tente novamente mais tarde.' });
  }
};
