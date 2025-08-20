import http, { IncomingMessage, ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import 'dotenv/config';
import handler from '../api/chat';

type Headers = IncomingMessage['headers'];

function readRequestBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

class VercelResponseAdapter {
  private res: ServerResponse;
  constructor(res: ServerResponse) {
    this.res = res;
  }
  setHeader(name: string, value: string) {
    this.res.setHeader(name, value);
  }
  status(code: number) {
    this.res.statusCode = code;
    return this;
  }
  json(obj: unknown) {
    if (!this.res.getHeader('Content-Type')) {
      this.res.setHeader('Content-Type', 'application/json');
    }
    this.res.end(JSON.stringify(obj));
    return this;
  }
  end(body?: string) {
    this.res.end(body);
    return this;
  }
}

function createReqLike(method: string | undefined, headers: Headers, body: string) {
  return {
    method,
    headers,
    body,
  } as any; // matches usage in our handler
}

// Provide sensible dev defaults for local testing
if (!process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS = '*';
}

const server = http.createServer(async (req, res) => {
  try {
    // Only proxy to our handler path
    if (!req.url?.startsWith('/api/chat')) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const rawBody = await readRequestBody(req).catch((err) => {
      const code = (err as any)?.status ?? 400;
      res.statusCode = code;
      res.end((err as Error).message);
      return null;
    });
    if (rawBody === null) return;

    const reqLike = createReqLike(req.method, req.headers, rawBody);
    const resLike = new VercelResponseAdapter(res);
    await handler(reqLike, resLike as any);
  } catch (err: any) {
    res.statusCode = err?.status ?? 500;
    res.end(err?.message || 'Unknown error');
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  const { port: boundPort } = server.address() as AddressInfo;
  // eslint-disable-next-line no-console
  console.log(`Local dev server running at http://localhost:${boundPort}`);
});


