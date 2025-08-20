import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

function parseAllowedOrigins(): string[] {
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
  return allowedOriginsEnv
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  // If wildcard is present, allow regardless of origin presence
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  return allowed.includes(origin);
}

function applyCors(origin: string | undefined, allowed: string[], res: VercelResponse) {
  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && isOriginAllowed(origin, allowed)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS: apply headers and handle preflight AS EARLY AS POSSIBLE
  const allowedOrigins = parseAllowedOrigins();
  const origin = req.headers.origin as string | undefined;
  applyCors(origin, allowedOrigins, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (allowedOrigins.length === 0) {
    res.status(500).json({ error: 'Server misconfiguration: ALLOWED_ORIGINS is not set' });
    return;
  }

  // Enforce Origin to be explicitly allowed for cross-origin requests
  if (!isOriginAllowed(origin, allowedOrigins)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  const allowMock = process.env.DEV_ALLOW_MOCK === '1';
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  if (!hasKey && !allowMock) {
    res.status(500).json({ error: 'Server misconfiguration: OPENAI_API_KEY is not set' });
    return;
  }

  try {
    const contentType = (req.headers['content-type'] || '').toString().toLowerCase();
    const rawBody = req.body as unknown;

    let userText = '';
    if (contentType.startsWith('text/plain')) {
      userText = typeof rawBody === 'string' ? rawBody : '';
    } else if (contentType.includes('application/json')) {
      const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody as any) || {};
      userText = typeof body?.text === 'string' ? body.text : '';
    } else {
      // Best effort: try JSON parse, else treat as empty
      try {
        const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : (rawBody as any) || {};
        userText = typeof body?.text === 'string' ? body.text : '';
      } catch {
        userText = '';
      }
    }

    userText = (userText || '').trim();

    // Basic validation and size limits (e.g., 8k characters)
    if (!userText) {
      res.status(400).json({ error: 'Invalid request: text is required' });
      return;
    }
    if (userText.length > 8000) {
      res.status(413).json({ error: 'Payload too large: text exceeds 8000 characters' });
      return;
    }

    const systemPrompt = (process.env.SYSTEM_PROMPT || 'You are a helpful and concise assistant.').trim();

    let content = '';
    if (allowMock && !hasKey) {
      const preview = userText.slice(0, 180).replace(/\s+/g, ' ').trim();
      content = `Mocked response (DEV_ALLOW_MOCK=1). You said: "${preview}${userText.length > 180 ? '…' : ''}"`;
    } else {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText }
        ],
      });

      const choice = completion.choices?.[0];
      content = choice?.message?.content ?? '';
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ content });
  } catch (err: any) {
    const status = err?.status ?? 500;
    res.status(status).json({
      error: err?.message || 'Unknown error',
    });
  }
}


