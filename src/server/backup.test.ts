import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { Config } from '../shared/types.js';
import { validateConfig } from './config.js';
import { redact } from './exec.js';
import { guardTriggered } from './jobs.js';
import { compareCounts, countBsonGz, MANIFEST_NAME, pruneDumps } from './mongo.js';
import { parseDryRun, parseProgress } from './rsync.js';

const temp = await mkdtemp(join(tmpdir(), 'backerupper-test-'));
after(() => rm(temp, { recursive: true, force: true }));

const bsonDoc = (size: number) => {
  const doc = Buffer.alloc(size);
  doc.writeInt32LE(size, 0);
  return doc;
};

test('redact strips credentials from connection strings', () => {
  assert.equal(
    redact('failed mongodb+srv://me:s3cret@cluster/db'),
    'failed mongodb+srv://<credentials>@cluster/db',
  );
});

test('countBsonGz counts documents across gzip chunks', async () => {
  const path = join(temp, 'a.bson.gz');
  const docs = Array.from({ length: 500 }, (_, i) => bsonDoc(5 + (i % 40) * 1000));
  await writeFile(path, gzipSync(Buffer.concat(docs)));
  assert.equal(await countBsonGz(path), 500);
});

test('countBsonGz rejects a truncated dump', async () => {
  const path = join(temp, 'b.bson.gz');
  await writeFile(path, gzipSync(bsonDoc(100).subarray(0, 50)));
  await assert.rejects(countBsonGz(path), /Truncated/);
});

test('compareCounts fails when a stable collection differs', () => {
  const result = compareCounts({ a: 3 }, { a: 2 }, { a: 3 });
  assert.equal(result.failures.length, 1);
});

test('compareCounts fails when a collection is missing from the dump', () => {
  assert.equal(compareCounts({ a: 3 }, {}, { a: 3 }).failures.length, 1);
});

test('compareCounts only warns when writes happened during the dump', () => {
  const result = compareCounts({ a: 3 }, { a: 4 }, { a: 5 });
  assert.deepEqual(result.failures, []);
  assert.equal(result.warnings.length, 1);
});

test('pruneDumps removes only its own oldest dumps', async () => {
  const root = join(temp, 'dumps');
  for (const [folder, created] of [['2026-01-01', 'a'], ['2026-01-02', 'b'], ['2026-01-03', 'c']] as const) {
    await mkdir(join(root, folder, 'tedography'), { recursive: true });
    await writeFile(join(root, folder, 'tedography', MANIFEST_NAME), JSON.stringify({ createdAt: created }));
  }
  // The oldest date also holds another database, and a hand-made dump has no manifest.
  await mkdir(join(root, '2026-01-01', 'other'), { recursive: true });
  await mkdir(join(root, '2020-01-01', 'tedography'), { recursive: true });
  const removed = await pruneDumps(root, 'tedography', 2);
  assert.deepEqual(removed, [join(root, '2026-01-01', 'tedography')]);
  assert.deepEqual((await readdir(root)).sort(), ['2020-01-01', '2026-01-01', '2026-01-02', '2026-01-03']);
});

test('parseDryRun separates new, changed and deleted files', () => {
  const plan = parseDryRun(
    [
      '*deleting   old/gone.jpg',
      '*deleting   old/',
      '.d..t...... kept/',
      'cd+++++++++ fresh/',
      '>f+++++++++ fresh/new file.jpg',
      '>f.st...... kept/edited.jpg',
      '',
      'Number of files: 10 (reg: 8, dir: 2)',
      'Total transferred file size: 1,234 bytes',
    ].join('\n'),
  );
  assert.equal(plan.newFiles, 1);
  assert.equal(plan.changedFiles, 1);
  assert.equal(plan.deletedFiles, 1);
  assert.equal(plan.sourceFiles, 8);
  assert.equal(plan.bytesToCopy, 1234);
  assert.deepEqual(plan.newSamples, ['fresh/new file.jpg']);
  assert.deepEqual(plan.replacedSamples, ['old/gone.jpg', 'kept/edited.jpg']);
});

test('parseProgress reads rsync progress2 output', () => {
  assert.deepEqual(parseProgress('  1,234,567  45%   12.34MB/s    0:00:10 (xfr#3, to-chk=0/12)'), {
    percent: 45,
    rate: '12.34MB/s',
    eta: '0:00:10',
  });
});

test('guard ignores small changes and catches large shares', () => {
  const guard = { replacedPercent: 5, replacedMinFiles: 20 };
  assert.equal(guardTriggered(guard, { changedFiles: 5, deletedFiles: 5, newFiles: 0, sourceFiles: 10 }), false);
  assert.equal(guardTriggered(guard, { changedFiles: 0, deletedFiles: 20, newFiles: 0, sourceFiles: 100 }), true);
  assert.equal(guardTriggered(guard, { changedFiles: 0, deletedFiles: 21, newFiles: 0, sourceFiles: 37000 }), false);
});

const baseConfig = (): Config => ({
  tools: { rsync: 'r', mongodump: 'm' },
  excludes: [],
  guard: { replacedPercent: 5, replacedMinFiles: 20 },
  freeSpaceMarginMB: 1,
  volumes: [{ id: 'a', label: 'A', uuid: '1' }],
  apps: [],
});

test('config refuses a backup onto its own source drive', () => {
  const config = baseConfig();
  config.apps = [{
    id: 'x', name: 'X',
    items: [{ id: 'f', type: 'files', label: 'F', defaultSelected: true, sourceVolume: 'a', sourcePath: 'p', destVolume: 'a', destPath: 'q', replacedRoot: 'r' }],
  }];
  assert.throws(() => validateConfig(config), /same drive/);
});

test('config refuses paths that escape a volume', () => {
  const config = baseConfig();
  config.volumes.push({ id: 'b', label: 'B', uuid: '2' });
  config.apps = [{
    id: 'x', name: 'X',
    items: [{ id: 'f', type: 'files', label: 'F', defaultSelected: true, sourceVolume: 'a', sourcePath: 'p', destVolume: 'b', destPath: '../q', replacedRoot: 'r' }],
  }];
  assert.throws(() => validateConfig(config), /relative path/);
});
