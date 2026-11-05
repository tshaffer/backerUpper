import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  Config,
  FilesItemConfig,
  ItemConfig,
  Job,
  JobItem,
  MongoItemConfig,
  Plan,
  PlanItem,
  RunItemRecord,
} from '../shared/types.js';
import { allItems, itemVolumes } from './config.js';
import { exec, redact } from './exec.js';
import { saveRun } from './history.js';
import {
  compareCounts,
  countDump,
  MANIFEST_NAME,
  publishDump,
  pruneDumps,
  readCounts,
  readMongoUri,
  runMongodump,
  type DumpManifest,
} from './mongo.js';
import { copy, dryRun, type RsyncJob } from './rsync.js';
import { canWrite, freeBytes, resolveVolume } from './volumes.js';

const PLAN_MAX_AGE_MS = 30 * 60 * 1000;
const DUMP_ESTIMATE = 50 * 1024 ** 2;
const LOG_LINES = 200;

let job: Job | null = null;
let controller: AbortController | null = null;

export const currentJob = (): Job | null => job;
export const isBusy = (): boolean => job?.status === 'running';

export function cancelJob(): boolean {
  if (!isBusy() || !controller) return false;
  controller.abort();
  return true;
}

function log(line: string): void {
  if (!job) return;
  job.log.push(redact(line));
  job.log.splice(0, Math.max(0, job.log.length - LOG_LINES));
}

function startJob(kind: Job['kind'], items: JobItem[]): Job {
  controller = new AbortController();
  job = { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString(), items, log: [] };
  return job;
}

function finishJob(current: Job, status: Job['status'], error?: string): void {
  current.status = status;
  current.finishedAt = new Date().toISOString();
  if (error) current.error = redact(error);
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function localDate(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function runIdFor(now = new Date()): string {
  return `${localDate(now)}T${now.toTimeString().slice(0, 8).replaceAll(':', '-')}`;
}

function selectedItems(config: Config, keys: string[]) {
  const wanted = new Set(keys);
  return allItems(config).filter(({ key }) => wanted.has(key));
}

async function resolveMounts(config: Config, items: ItemConfig[]): Promise<Map<string, string>> {
  const mounts = new Map<string, string>();
  const needed = new Set(items.flatMap(itemVolumes));
  for (const volume of config.volumes) {
    if (!needed.has(volume.id)) continue;
    const path = await resolveVolume(volume);
    if (path) mounts.set(volume.id, path);
  }
  return mounts;
}

/** Each run gets its own dated folder for replaced files, so nothing in one gets overwritten. */
export async function replacedDirFor(destMount: string, item: FilesItemConfig, date: string): Promise<string> {
  const root = join(destMount, item.replacedRoot);
  const name = basename(item.destPath);
  for (let index = 1; ; index += 1) {
    const dir = join(root, index === 1 ? date : `${date}-${index}`, name);
    const taken = await stat(dir).then(
      () => true,
      () => false,
    );
    if (!taken) return dir;
  }
}

export function guardTriggered(
  guard: Config['guard'],
  plan: { changedFiles: number; deletedFiles: number; newFiles: number; sourceFiles: number },
): boolean {
  const replaced = plan.changedFiles + plan.deletedFiles;
  const destFiles = plan.sourceFiles - plan.newFiles + plan.deletedFiles;
  if (replaced < guard.replacedMinFiles) return false;
  return (replaced / Math.max(destFiles, 1)) * 100 >= guard.replacedPercent;
}

async function isEmptyDir(path: string): Promise<boolean> {
  const names = await readdir(path);
  return names.filter((name) => !name.startsWith('.')).length === 0;
}

async function planFiles(
  config: Config,
  key: string,
  item: FilesItemConfig,
  mounts: Map<string, string>,
  signal: AbortSignal,
): Promise<PlanItem> {
  const result: PlanItem = {
    key,
    label: item.label,
    type: 'files',
    blockers: [],
    warnings: [],
    guardTriggered: false,
  };
  const sourceMount = mounts.get(item.sourceVolume);
  const destMount = mounts.get(item.destVolume);
  if (!sourceMount || !destMount) {
    result.blockers.push('A required drive is not mounted.');
    return result;
  }
  const source = join(sourceMount, item.sourcePath);
  const dest = join(destMount, item.destPath);
  const sourceEmpty = await isEmptyDir(source).catch(() => null);
  if (sourceEmpty === null) {
    result.blockers.push(`Source folder not found: ${source}`);
    return result;
  }
  const destinationExists = await stat(dest).then(
    () => true,
    () => false,
  );
  if (sourceEmpty && destinationExists && !(await isEmptyDir(dest))) {
    result.blockers.push('The source is empty but its backup is not. Refusing to mirror an empty folder.');
    return result;
  }
  const replacedDir = await replacedDirFor(destMount, item, localDate());
  const dry = await dryRun(
    { rsync: config.tools.rsync, source, dest, replacedDir, excludes: config.excludes },
    signal,
  );
  result.files = { ...dry, destinationExists, replacedDir };
  result.guardTriggered = guardTriggered(config.guard, dry);
  return result;
}

async function planMongo(
  key: string,
  item: MongoItemConfig,
  mounts: Map<string, string>,
  signal: AbortSignal,
): Promise<PlanItem> {
  const result: PlanItem = {
    key,
    label: item.label,
    type: 'mongo',
    blockers: [],
    warnings: [],
    guardTriggered: false,
  };
  if (item.destinations.some((id) => !mounts.has(id))) {
    result.blockers.push('A required drive is not mounted.');
    return result;
  }
  try {
    const counts = await readCounts(await readMongoUri(item), item.database, signal);
    const values = Object.values(counts);
    if (values.length === 0) {
      result.blockers.push(`Database "${item.database}" has no collections.`);
      return result;
    }
    result.mongo = {
      collections: values.length,
      documents: values.reduce((sum, count) => sum + count, 0),
      destinations: item.destinations.map((id) => join(mounts.get(id)!, item.root)),
    };
  } catch (error) {
    result.blockers.push(`Could not reach the database: ${errorText(error)}`);
  }
  return result;
}

async function checkTool(path: string, name: string): Promise<string | null> {
  try {
    const result = await exec(path, ['--version']);
    if (result.code !== 0) return `${name} failed to run (${path}).`;
    if (name === 'rsync' && !/version\s+3\./.test(result.stdout)) {
      return `${path} is not rsync 3.x, which backerUpper needs.`;
    }
    return null;
  } catch {
    return `${name} was not found at ${path}.`;
  }
}

async function checkDrives(
  config: Config,
  selected: { key: string; item: ItemConfig }[],
  mounts: Map<string, string>,
  plans: PlanItem[],
): Promise<string[]> {
  const blockers: string[] = [];
  const labelOf = (id: string) => config.volumes.find((v) => v.id === id)?.label ?? id;
  const destinationsOf = (item: ItemConfig) =>
    item.type === 'mongo' ? item.destinations : [item.destVolume];
  const destinations = new Set(selected.flatMap(({ item }) => destinationsOf(item)));
  for (const id of destinations) {
    const mount = mounts.get(id);
    if (mount && !(await canWrite(mount))) {
      blockers.push(
        `macOS would not let backerUpper write to ${labelOf(id)}. Check Privacy & Security for the app running it.`,
      );
    }
  }
  const needed = new Map<string, number>();
  for (const plan of plans) {
    const item = selected.find((entry) => entry.key === plan.key)?.item;
    if (!item) continue;
    const bytes = plan.files ? plan.files.bytesToCopy : plan.mongo ? DUMP_ESTIMATE : 0;
    for (const id of destinationsOf(item)) needed.set(id, (needed.get(id) ?? 0) + bytes);
  }
  for (const [id, bytes] of needed) {
    const mount = mounts.get(id);
    if (mount && (await freeBytes(mount)) < bytes + config.freeSpaceMarginMB * 1024 ** 2) {
      blockers.push(`${labelOf(id)} does not have enough free space for this backup.`);
    }
  }
  return blockers;
}

export function startPlan(config: Config, keys: string[]): Job {
  const selected = selectedItems(config, keys);
  if (selected.length === 0) throw new Error('Nothing selected.');
  const current = startJob(
    'plan',
    selected.map(({ key, item }) => ({ key, label: item.label, state: 'pending' })),
  );
  const { signal } = controller!;
  void (async () => {
    try {
      const items = selected.map((entry) => entry.item);
      const blockers: string[] = [];
      for (const [path, name] of [
        [config.tools.rsync, 'rsync'],
        [config.tools.mongodump, 'mongodump'],
      ] as const) {
        const problem = await checkTool(path, name);
        if (problem) blockers.push(problem);
      }
      const mounts = await resolveMounts(config, items);
      const plans: PlanItem[] = [];
      for (const { key, item } of selected) {
        const progress = current.items.find((entry) => entry.key === key)!;
        progress.state = 'running';
        try {
          const plan =
            item.type === 'mongo'
              ? await planMongo(key, item, mounts, signal)
              : await planFiles(config, key, item, mounts, signal);
          plans.push(plan);
          progress.state = plan.blockers.length ? 'failed' : 'ok';
        } catch (error) {
          signal.throwIfAborted();
          plans.push({
            key,
            label: item.label,
            type: item.type,
            blockers: [errorText(error)],
            warnings: [],
            guardTriggered: false,
          });
          progress.state = 'failed';
        }
      }
      blockers.push(...(await checkDrives(config, selected, mounts, plans)));
      const plan: Plan = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        items: plans,
        blockers,
        guardTriggered: plans.some((p) => p.guardTriggered),
      };
      current.plan = plan;
      finishJob(current, 'done');
    } catch (error) {
      if (signal.aborted) finishJob(current, 'cancelled');
      else finishJob(current, 'failed', errorText(error));
    }
  })();
  return current;
}

function setItem(item: JobItem, patch: Partial<JobItem>): void {
  Object.assign(item, patch);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function runMongoItem(
  config: Config,
  item: MongoItemConfig,
  progress: JobItem,
  mounts: Map<string, string>,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const uri = await readMongoUri(item);
  const date = localDate();
  const roots = item.destinations.map((id) => join(mounts.get(id)!, item.root));
  const firstRoot = roots[0]!;
  await mkdir(firstRoot, { recursive: true });
  const work = await mkdtemp(join(firstRoot, '.work-'));
  const warnings: string[] = [];
  try {
    setItem(progress, { detail: 'Counting documents' });
    const before = await readCounts(uri, item.database, signal);
    setItem(progress, { detail: 'Running mongodump' });
    await runMongodump(config.tools.mongodump, uri, item.database, work, log, signal);
    const dumpDir = join(work, item.database);
    setItem(progress, { detail: 'Verifying dump' });
    const dumped = await countDump(dumpDir);
    const after = await readCounts(uri, item.database, signal);
    const check = compareCounts(before, dumped, after);
    if (check.failures.length) throw new Error(`Verification failed: ${check.failures.join('; ')}`);
    warnings.push(...check.warnings);

    const manifest: DumpManifest = {
      runId,
      createdAt: new Date().toISOString(),
      database: item.database,
      tool: 'mongodump --gzip',
      collections: dumped,
    };
    await writeFile(join(dumpDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

    const published: string[] = [];
    for (const root of roots) {
      setItem(progress, { detail: `Writing to ${root}` });
      await mkdir(root, { recursive: true });
      published.push(await publishDump(dumpDir, root, date, item.database, dumped));
    }
    for (const root of roots) {
      const removed = await pruneDumps(root, item.database, item.retention);
      removed.forEach((path) => log(`Removed old dump ${path}`));
    }
    const documents = Object.values(dumped).reduce((sum, count) => sum + count, 0);
    published.forEach((path) => log(`Published ${path}`));
    setItem(progress, {
      state: warnings.length ? 'warning' : 'ok',
      detail: [
        `${Object.keys(dumped).length} collections, ${documents.toLocaleString()} documents verified on ${published.length} drives`,
        ...warnings,
      ].join('. '),
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function runFilesItem(
  config: Config,
  item: FilesItemConfig,
  progress: JobItem,
  mounts: Map<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const source = join(mounts.get(item.sourceVolume)!, item.sourcePath);
  const dest = join(mounts.get(item.destVolume)!, item.destPath);
  if (await isEmptyDir(source)) {
    if (!(await isEmptyDir(dest).catch(() => true))) {
      throw new Error('The source is empty but its backup is not. Refusing to mirror it.');
    }
  }
  await mkdir(dirname(dest), { recursive: true });
  // rsync only creates this folder if it actually has something to move into it.
  const replacedDir = await replacedDirFor(mounts.get(item.destVolume)!, item, localDate());
  const rsyncJob: RsyncJob = { rsync: config.tools.rsync, source, dest, replacedDir, excludes: config.excludes };

  setItem(progress, { detail: 'Copying', percent: 0 });
  const outcome = await copy(
    rsyncJob,
    ({ percent, rate, eta }) => setItem(progress, { percent, rate, eta }),
    signal,
  );
  setItem(progress, { percent: undefined, rate: undefined, eta: undefined });
  if (signal.aborted) throw new Error('Cancelled');
  if (outcome.code !== 0 && outcome.code !== 24) {
    throw new Error(`rsync failed with exit code ${outcome.code}: ${outcome.stderr.slice(-400)}`);
  }

  setItem(progress, { detail: 'Verifying' });
  const verify = await dryRun(rsyncJob, signal);
  const remaining = verify.newFiles + verify.changedFiles + verify.deletedFiles;
  const plural = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
  const summary = `${plural(outcome.filesCopied, 'file')} copied (${formatBytes(outcome.bytesCopied)}), ${plural(outcome.filesDeleted, 'file')} moved out of the mirror`;
  if (remaining > 0 || outcome.code === 24) {
    setItem(progress, {
      state: 'warning',
      detail: `${summary}. ${plural(remaining, 'file')} still differ, probably changed during the run. Run it again to catch up.`,
    });
  } else {
    setItem(progress, { state: 'ok', detail: `${summary}. Verified.` });
  }
}

function keepAwake(): () => void {
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => undefined);
  return () => child.kill();
}

export function startRun(config: Config, planId: string, acknowledgeGuard: boolean): Job {
  // Only a finished, unused plan qualifies: a plan can't be replayed once it has run.
  const plan = job?.kind === 'plan' && job.status === 'done' ? job.plan : undefined;
  if (!plan || plan.id !== planId) throw new Error('That plan is no longer current. Create a new one.');
  if (Date.now() - new Date(plan.createdAt).getTime() > PLAN_MAX_AGE_MS) {
    throw new Error('That plan is more than 30 minutes old. Create a new one.');
  }
  if (plan.blockers.length || plan.items.some((item) => item.blockers.length)) {
    throw new Error('This plan has problems that must be fixed first.');
  }
  if (plan.guardTriggered && !acknowledgeGuard) {
    throw new Error('This plan replaces an unusually large share of files and needs your confirmation.');
  }
  const selected = selectedItems(
    config,
    plan.items.map((item) => item.key),
  );
  const current = startJob(
    'run',
    selected.map(({ key, item }) => ({ key, label: item.label, state: 'pending' })),
  );
  current.plan = plan;
  const { signal } = controller!;
  const runId = runIdFor();
  const release = keepAwake();

  void (async () => {
    try {
      for (const { key, item } of selected) {
        const progress = current.items.find((entry) => entry.key === key)!;
        if (signal.aborted) {
          progress.state = 'cancelled';
          continue;
        }
        setItem(progress, { state: 'running' });
        // Drives are matched again for every item, in case one was swapped since the plan.
        const mounts = await resolveMounts(config, [item]);
        const missing = itemVolumes(item).filter((id) => !mounts.has(id));
        if (missing.length) {
          setItem(progress, { state: 'failed', detail: 'A required drive is no longer mounted.' });
          continue;
        }
        try {
          if (item.type === 'mongo') await runMongoItem(config, item, progress, mounts, runId, signal);
          else await runFilesItem(config, item, progress, mounts, signal);
        } catch (error) {
          setItem(progress, signal.aborted
            ? { state: 'cancelled', detail: 'Cancelled. Finished work is kept; run it again to continue.' }
            : { state: 'failed', detail: redact(errorText(error)) });
        }
      }
      const records: RunItemRecord[] = current.items.map(({ key, label, state, detail }) => ({
        key,
        label,
        state,
        detail,
      }));
      const items = selected.map((entry) => entry.item);
      const mounts = await resolveMounts(config, items);
      const failedDrives = await saveRun(
        { runId, startedAt: current.startedAt, finishedAt: new Date().toISOString(), items: records },
        [...mounts.values()],
      );
      if (failedDrives.length) {
        current.manifestWarnings = failedDrives.map((path) => `Could not write the run record to ${path}.`);
      }
      finishJob(current, signal.aborted ? 'cancelled' : 'done');
    } catch (error) {
      finishJob(current, 'failed', errorText(error));
    } finally {
      release();
    }
  })();
  return current;
}

