import { DEMO } from '../../domain/config';
import { decode, encode } from '../../domain/serialize';
import { ApiError, type ApiClient, type Role } from './types';

async function parse(res: Response) {
  const text = await res.text();
  const body = text ? decode<any>(text) : {};
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(err.code ?? 'HTTP_ERROR', err.message ?? `Request failed (${res.status}).`, err.details);
  }
  return body;
}

export function createHttpApi(base = ''): ApiClient {
  const token = (() => {
    try {
      return localStorage.getItem('flop-pool:operator-token') ?? '';
    } catch {
      return '';
    }
  })();
  const headers = (role: Role): Record<string, string> => ({
    'Content-Type': 'application/json',
    'X-Demo-Role': role,
    'X-Demo-User': DEMO.demoUserId,
    ...(token && role !== 'participant' ? { Authorization: `Bearer ${token}` } : {}),
  });
  return {
    mode: 'http',
    async view(name, params = {}) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]);
      return parse(await fetch(`${base}/api/views/${name}?${q}`));
    },
    async command(role, type, input, idempotencyKey) {
      const send = () => fetch(`${base}/api/commands`, { method: 'POST', headers: headers(role), body: encode({ type, input, idempotencyKey }) });
      let res: Response;
      try {
        res = await send();
      } catch {
        // Network failure: retrying with the same idempotency key cannot double-apply.
        res = await send();
      }
      return parse(res);
    },
    async reset() {
      await parse(await fetch(`${base}/api/demo/reset`, { method: 'POST', headers: headers('demo') }));
    },
  };
}
