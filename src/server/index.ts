import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiApp } from './app.js';
import { GoldPriceRepository } from './db/goldRepository.js';
import { ensureTwoYearDataSynced } from './services/goldDataSync.js';

function findProjectRoot(): string {
  let curr = path.dirname(fileURLToPath(import.meta.url));
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'package.json'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'gold_prices.sqlite');
const repository = new GoldPriceRepository(dbPath);
const bounds = ensureTwoYearDataSynced(repository, new Date());

const app = createApiApp({ repository });

async function startServer(): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  const distClientDir = path.join(PROJECT_ROOT, 'dist/client');

  if (isProd || fs.existsSync(path.join(distClientDir, 'index.html'))) {
    app.use(express.static(distClientDir));
    // SPA fallback for all non-API GET requests
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(path.join(distClientDir, 'index.html'));
      } else {
        next();
      }
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: path.join(PROJECT_ROOT, 'src/client'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, () => {
    console.log(
      `[AurumTrack] Server listening on http://localhost:${PORT} (2-Year Window: ${bounds.minDate} -> ${bounds.maxDate})`,
    );
  });
}

startServer().catch((err) => {
  console.error('[AurumTrack] Failed to start server:', err);
  process.exit(1);
});
