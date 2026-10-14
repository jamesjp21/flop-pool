import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createEmbeddedApi } from './api/embedded';
import { createHttpApi } from './api/http';
import type { ApiClient } from './api/types';

declare const __BACKEND__: 'http' | 'embedded';

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  let api: ApiClient;
  let storageLabel: string;
  if (__BACKEND__ === 'embedded') {
    const embedded = await createEmbeddedApi();
    api = embedded;
    storageLabel = `${embedded.storageLabel}. The engine runs in this page.`;
  } else {
    api = createHttpApi();
    storageLabel = 'Saved by the server (SQLite).';
  }
  root.render(<App api={api} storageLabel={storageLabel} />);
}

boot().catch((e) => {
  const el = document.getElementById('root');
  if (el) el.textContent = `The demo failed to start: ${e instanceof Error ? e.message : String(e)}`;
});
