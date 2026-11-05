import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { parse as parseEnv } from 'dotenv';
import { MongoClient } from 'mongodb';
import type { MongoItemConfig } from '../shared/types.js';
import { expandHome } from './config.js';
import { exec, redact } from './exec.js';

export const MANIFEST_NAME = 'backup-manifest.json';

export type CollectionCounts = Record<string, number>;

export interface DumpManifest {
  runId: string;
  createdAt: string;
  database: string;
  tool: string;
  collections: CollectionCounts;
}

/** Reads the connection string at run time, so it is never copied into backerUpper. */
export async function readMongoUri(item: MongoItemConfig): Promise<string> {
  const path = expandHome(item.envFile);
  const values = parseEnv(await readFile(path, 'utf8'));
  const uri = values[item.envKey];
  if (!uri) throw new Error(`${item.envKey} is not set in ${item.envFile}`);
  return uri;
}

export async function readCounts(
  uri: string,
  database: string,
  signal?: AbortSignal,
): Promise<CollectionCounts> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db(database);
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    const counts: CollectionCounts = {};
    for (const { name, type } of collections) {
      signal?.throwIfAborted();
      if (type !== 'collection' || name.startsWith('system.')) continue;
      counts[name] = await db.collection(name).countDocuments({});
    }
    return counts;
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    await client.close();
  }
}

/** Counts documents by walking BSON length prefixes; throws if the file is cut short. */
export async function countBsonGz(path: string): Promise<number> {
  const stream = createReadStream(path).pipe(createGunzip());
  const header = Buffer.alloc(4);
  let filled = 0;
  let skip = 0;
  let count = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let offset = 0;
    while (offset < chunk.length) {
      if (skip > 0) {
        const step = Math.min(skip, chunk.length - offset);
        skip -= step;
        offset += step;
        continue;
      }
      const step = Math.min(4 - filled, chunk.length - offset);
      chunk.copy(header, filled, offset, offset + step);
      filled += step;
      offset += step;
      if (filled === 4) {
        const size = header.readInt32LE(0);
        if (size < 5) throw new Error(`Invalid BSON document size in ${path}`);
        count += 1;
        skip = size - 4;
        filled = 0;
      }
    }
  }
  if (skip > 0 || filled > 0) throw new Error(`Truncated BSON file: ${path}`);
  return count;
}

export async function countDump(dumpDir: string): Promise<CollectionCounts> {
  const counts: CollectionCounts = {};
  for (const name of await readdir(dumpDir)) {
    if (!name.endsWith('.bson.gz')) continue;
    counts[name.slice(0, -'.bson.gz'.length)] = await countBsonGz(join(dumpDir, name));
  }
  return counts;
}

export interface CountCheck {
  failures: string[];
  warnings: string[];
}

/**
 * Compares a dump with the database as counted just before and after it. A mismatch only
 * counts as a failure when the database held still; otherwise writes explain the difference.
 */
export function compareCounts(
  before: CollectionCounts,
  dumped: CollectionCounts,
  after: CollectionCounts,
): CountCheck {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const earlier = before[name];
    const later = after[name];
    const got = dumped[name];
    if (earlier !== undefined && later !== undefined && got === undefined) {
      failures.push(`${name} is missing from the dump`);
    } else if (earlier === later && got !== earlier) {
      failures.push(`${name}: database has ${earlier} documents, dump has ${got}`);
    } else if (earlier !== later) {
      warnings.push(`${name} changed during the backup (${earlier ?? 0} to ${later ?? 0} documents)`);
    }
  }
  return { failures, warnings };
}

export async function runMongodump(
  mongodump: string,
  uri: string,
  database: string,
  outDir: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  // A private config file keeps the connection string out of `ps`.
  const configDir = await mkdtemp(join(tmpdir(), 'backerupper-'));
  const configPath = join(configDir, 'mongodump.yaml');
  try {
    await writeFile(configPath, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
    const args = ['--config', configPath, '--db', database, '--gzip', '--out', outDir];
    const result = await exec(mongodump, args, {
      signal,
      onStderr: (text) => {
        for (const line of text.split('\n')) if (line.trim()) onLog(redact(line.trim()));
      },
    });
    if (signal?.aborted) throw new Error('Cancelled');
    if (result.code !== 0) throw new Error(`mongodump failed with exit code ${result.code}`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Picks `<date>/<database>`, using `<date>-2` and so on for later runs that day. */
export async function nextDumpFolder(root: string, date: string, database: string): Promise<string> {
  for (let index = 1; ; index += 1) {
    const dated = join(root, index === 1 ? date : `${date}-${index}`);
    if (!(await exists(join(dated, database)))) return dated;
  }
}

/**
 * Copies a finished dump to a destination via a temporary folder and rename, so a dump
 * under `<root>/<date>/` is always complete.
 */
export async function publishDump(
  sourceDir: string,
  root: string,
  date: string,
  database: string,
  expected: CollectionCounts,
): Promise<string> {
  const temp = join(root, `.tmp-${randomBytes(4).toString('hex')}`);
  await mkdir(temp, { recursive: true });
  try {
    await cp(sourceDir, temp, { recursive: true });
    const copied = await countDump(temp);
    for (const [name, count] of Object.entries(expected)) {
      if (copied[name] !== count) throw new Error(`Copy check failed for ${name}`);
    }
    const dated = await nextDumpFolder(root, date, database);
    await mkdir(dated, { recursive: true });
    const finalDir = join(dated, database);
    await rename(temp, finalDir);
    return finalDir;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Keeps the newest `retention` dumps of one database. Only dumps with backerUpper's manifest
 * are ever removed, so hand-made dumps and other databases in a dated folder stay untouched.
 */
export async function pruneDumps(root: string, database: string, retention: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const dumps: { dir: string; createdAt: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name, database);
    try {
      const manifest = JSON.parse(await readFile(join(dir, MANIFEST_NAME), 'utf8')) as DumpManifest;
      dumps.push({ dir, createdAt: manifest.createdAt });
    } catch {
      // No readable manifest, so this dump is not backerUpper's to remove.
    }
  }
  dumps.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const removed: string[] = [];
  for (const { dir } of dumps.slice(retention)) {
    await rm(dir, { recursive: true, force: true });
    await rmdir(join(dir, '..')).catch(() => undefined);
    removed.push(dir);
  }
  return removed;
}
