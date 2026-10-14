import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Service } from '../domain/service';
import { createApp } from './app';
import { SqliteStore } from './sqliteStore';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const port = Number(env.PORT ?? 8787);
// Bind to loopback by default: this is a private demo, not a public service.
const host = env.HOST ?? '127.0.0.1';
const dbPath = env.DB_PATH ?? join(resolve(env.DATA_DIR ?? 'data'), 'flop-pool.db');
const demoEnabled = (env.DEMO_MODE ?? 'true') !== 'false';

const store = new SqliteStore(dbPath);
const service = await Service.open(store, {
  demoEnabled,
  env: { VAST_API_KEY: env.VAST_API_KEY, RUNPOD_API_KEY: env.RUNPOD_API_KEY },
});
const app = createApp(service, {
  staticDir: env.STATIC_DIR ?? resolve(here, '../web'),
  operatorToken: env.OPERATOR_TOKEN || undefined,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
});

app.listen(port, host, () => {
  console.log(`Flop Pool prototype (simulated funds only) on http://${host}:${port}`);
  console.log(`Store: ${store.label} · events: ${service.state.seq} · demo controls: ${demoEnabled ? 'on' : 'off'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close();
    store.close();
    process.exit(0);
  });
}
