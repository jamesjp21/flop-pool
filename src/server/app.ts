// HTTP API. Dependency-free (node:http).
//
//   GET  /api/health
//   GET  /api/views/:name?viewer=&id=&campaignId=&limit=   (home, campaign, portfolio, operator, ledger, audit, meta)
//   POST /api/commands   { type, input, idempotencyKey }
//   POST /api/demo/reset
//   GET  /*              static web build (dist/web)
//
// Roles in this prototype come from headers set by the demo UI:
//   X-Demo-Role: participant | operator | demo, and X-Demo-User for participants.
// This is not authentication. If OPERATOR_TOKEN is set, operator and demo
// requests must also send `Authorization: Bearer <token>`.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { DomainError, httpStatusFor } from '../domain/errors';
import { decode, encode } from '../domain/serialize';
import type { Service } from '../domain/service';
import type { Actor } from '../domain/types';

export interface AppOptions {
  staticDir?: string;
  operatorToken?: string;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: unknown) {
  const text = encode(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(text);
}

function sendError(res: ServerResponse, e: unknown, log?: (m: string) => void) {
  if (e instanceof DomainError) return send(res, httpStatusFor(e.code), { error: { code: e.code, message: e.message, details: e.details } });
  if (e instanceof SyntaxError) return send(res, 400, { error: { code: 'INVALID_INPUT', message: 'Request body is not valid JSON.' } });
  log?.(`Unhandled error: ${e instanceof Error ? e.stack : String(e)}`);
  return send(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong on the server. Nothing was changed.' } });
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new DomainError('INVALID_INPUT', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function actorFrom(req: IncomingMessage, service: Service, opts: AppOptions): Actor {
  const role = String(req.headers['x-demo-role'] ?? 'participant');
  if (role === 'operator' || role === 'demo') {
    if (opts.operatorToken) {
      const auth = String(req.headers.authorization ?? '');
      if (auth !== `Bearer ${opts.operatorToken}`) throw new DomainError('FORBIDDEN', 'Operator token required.');
    }
    return role === 'operator' ? { kind: 'operator', id: 'operator-console' } : { kind: 'demo', id: 'demo-controls' };
  }
  if (role !== 'participant') throw new DomainError('FORBIDDEN', `Unknown role ${role}.`);
  const user = String(req.headers['x-demo-user'] ?? 'u-demo');
  if (!service.state.users[user]) throw new DomainError('FORBIDDEN', `Unknown participant ${user}.`);
  return { kind: 'participant', id: user };
}

function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string) {
  const url = new URL(req.url ?? '/', 'http://local');
  const root = resolve(dir);
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Web build not found. Run `npm run build`.');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  createReadStream(file).pipe(res);
}

export function createApp(service: Service, opts: AppOptions = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, store: service.store.kind, seq: service.state.seq, clock: service.state.clock });
      }
      const view = /^\/api\/views\/([a-z]+)$/.exec(url.pathname);
      if (view && req.method === 'GET') {
        const params = Object.fromEntries(url.searchParams.entries());
        return send(res, 200, service.view(view[1], params));
      }
      if (url.pathname === '/api/commands' && req.method === 'POST') {
        const body = decode<{ type?: unknown; input?: unknown; idempotencyKey?: unknown }>(await readBody(req));
        if (!body || typeof body !== 'object' || typeof body.type !== 'string') throw new DomainError('INVALID_INPUT', 'Body must be { type, input, idempotencyKey }.');
        const actor = actorFrom(req, service, opts);
        const out = await service.execute(
          { type: body.type, input: (body.input ?? {}) as Record<string, unknown>, idempotencyKey: String(body.idempotencyKey ?? '') },
          actor,
        );
        opts.log?.(`${actor.kind}:${actor.id} ${body.type}${out.duplicate ? ' (duplicate)' : ''} -> seq ${out.seq}`);
        return send(res, out.duplicate ? 200 : 201, out);
      }
      if (url.pathname === '/api/demo/reset' && req.method === 'POST') {
        const actor = actorFrom(req, service, opts);
        if (actor.kind !== 'demo' && actor.kind !== 'operator') throw new DomainError('FORBIDDEN', 'Only demo controls can reset the demo.');
        await service.reset();
        opts.log?.('demo reset');
        return send(res, 200, { ok: true, seq: service.state.seq });
      }
      if (url.pathname.startsWith('/api/')) throw new DomainError('NOT_FOUND', 'No such endpoint.');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new DomainError('NOT_FOUND', 'No such endpoint.');
      if (!opts.staticDir) throw new DomainError('NOT_FOUND', 'No static files configured.');
      return serveStatic(req, res, opts.staticDir);
    } catch (e) {
      return sendError(res, e, opts.log);
    }
  });
}
