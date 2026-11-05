import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppState, AppView, ItemView } from '../shared/types.js';
import { itemKey, itemVolumes, loadConfig, PROJECT_ROOT } from './config.js';
import { lastBackups } from './history.js';
import { cancelJob, currentJob, isBusy, startPlan, startRun } from './jobs.js';
import { ejectVolume, volumeStatuses } from './volumes.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.BACKERUPPER_PORT ?? 4199);
const config = loadConfig();
const app = express();

// This server can start backups, so only this machine's own page may talk to it. The Host and
// Origin checks and the custom header stop other websites reaching it through the browser.
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

function localOnly(req: Request, res: Response, next: NextFunction): void {
  const originOk = !req.headers.origin || allowedOrigins.has(req.headers.origin);
  const headerOk = req.method === 'GET' || req.headers['x-backerupper'] === '1';
  if (!allowedHosts.has(req.headers.host ?? '') || !originOk || !headerOk) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

app.use(localOnly);
app.use(express.json());

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    handler(req, res).catch((error: unknown) => {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    });
  };

app.get(
  '/api/state',
  asyncRoute(async (_req, res) => {
    const volumes = await volumeStatuses(config.volumes);
    const mountPaths = volumes.flatMap((v) => (v.readable && v.mountPath ? [v.mountPath] : []));
    const latest = await lastBackups(mountPaths);
    const apps: AppView[] = config.apps.map((entry) => ({
      id: entry.id,
      name: entry.name,
      items: entry.items.map((item): ItemView => {
        const key = itemKey(entry.id, item.id);
        return {
          key,
          label: item.label,
          note: item.note,
          type: item.type,
          defaultSelected: item.defaultSelected,
          volumes: itemVolumes(item),
          lastBackupAt: latest[key],
        };
      }),
    }));
    const state: AppState = { apps, volumes, job: currentJob() };
    res.json(state);
  }),
);

app.post(
  '/api/plan',
  asyncRoute(async (req, res) => {
    if (isBusy()) throw new Error('Another job is already running.');
    const { keys } = req.body as { keys?: unknown };
    if (!Array.isArray(keys)) throw new Error('keys must be a list.');
    res.json(startPlan(config, keys.filter((key): key is string => typeof key === 'string')));
  }),
);

app.post(
  '/api/run',
  asyncRoute(async (req, res) => {
    if (isBusy()) throw new Error('Another job is already running.');
    const { planId, acknowledgeGuard } = req.body as { planId?: unknown; acknowledgeGuard?: unknown };
    if (typeof planId !== 'string') throw new Error('planId is required.');
    res.json(startRun(config, planId, acknowledgeGuard === true));
  }),
);

app.post('/api/cancel', (_req, res) => {
  res.json({ cancelled: cancelJob() });
});

app.post(
  '/api/eject',
  asyncRoute(async (req, res) => {
    if (isBusy()) throw new Error('A job is running.');
    const { volumeId } = req.body as { volumeId?: unknown };
    const volumes = await volumeStatuses(config.volumes);
    const volume = volumes.find((v) => v.id === volumeId);
    if (!volume?.mountPath) throw new Error('That drive is not mounted.');
    const result = await ejectVolume(volume.mountPath);
    if (!result.ok) throw new Error(result.message || 'macOS could not eject the drive.');
    res.json({ ok: true });
  }),
);

const dist = join(PROJECT_ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`backerUpper is running at http://${HOST}:${PORT}`);
});
