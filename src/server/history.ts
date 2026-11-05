import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../shared/types.js';

const DRIVE_FOLDER = 'BackerUpper/runs';

function localDir(): string {
  return (
    process.env.BACKERUPPER_HISTORY_DIR ??
    join(homedir(), 'Library/Application Support/backerUpper/runs')
  );
}

async function readRuns(dir: string): Promise<RunRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const runs = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        readFile(join(dir, name), 'utf8')
          .then((text) => JSON.parse(text) as RunRecord)
          .catch(() => null),
      ),
  );
  return runs.filter((run): run is RunRecord => run !== null);
}

async function writeRun(dir: string, run: RunRecord): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

/** Saves a run locally and on each drive, returning any drive that could not be written. */
export async function saveRun(run: RunRecord, mountPaths: string[]): Promise<string[]> {
  await writeRun(localDir(), run);
  const failed: string[] = [];
  for (const mountPath of mountPaths) {
    await writeRun(join(mountPath, DRIVE_FOLDER), run).catch(() => failed.push(mountPath));
  }
  return failed;
}

/** Newest successful time per item, from this Mac plus any mounted drive. */
export async function lastBackups(mountPaths: string[]): Promise<Record<string, string>> {
  const groups = await Promise.all([
    readRuns(localDir()),
    ...mountPaths.map((path) => readRuns(join(path, DRIVE_FOLDER))),
  ]);
  const latest: Record<string, string> = {};
  for (const run of groups.flat()) {
    for (const item of run.items) {
      if (item.state !== 'ok' && item.state !== 'warning') continue;
      const current = latest[item.key];
      if (!current || run.finishedAt > current) latest[item.key] = run.finishedAt;
    }
  }
  return latest;
}
