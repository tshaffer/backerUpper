// Tries to list a drive several ways, to find which way of starting a process macOS blocks.
// Usage: node scripts/diagnose-drive-access.mjs [/Volumes/NAME]
import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? '/Volumes/SHAFFEROTO';
const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const probe = `require('fs').readdirSync(${JSON.stringify(target)})`;
const report = (name, fn) => {
  try { fn(); console.log(`ok      ${name}`); } catch (e) { console.log(`FAILED  ${name}: ${e.code ?? e.message}`); }
};
const child = (cmd, args, opts = {}) => () => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').pop());
};

report('this node, readdirSync', () => readdirSync(target));
try { await readdir(target); console.log('ok      this node, fs/promises readdir'); }
catch (e) { console.log(`FAILED  this node, fs/promises readdir: ${e.code}`); }
report('child node', child(process.execPath, ['-e', probe]));
report('child ls', child('/bin/ls', [target]));
report('tsx', child(join(project, 'node_modules/.bin/tsx'), ['-e', probe], { cwd: project }));
report('tsx with cwd elsewhere', child(join(project, 'node_modules/.bin/tsx'), ['-e', probe], { cwd: '/tmp' }));
