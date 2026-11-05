import type { FilesPlan } from '../shared/types.js';
import { exec, redact } from './exec.js';

export interface RsyncJob {
  rsync: string;
  source: string;
  dest: string;
  replacedDir: string;
  excludes: string[];
}

const SAMPLE_LIMIT = 20;

function baseArgs(job: RsyncJob): string[] {
  return [
    // No -a: exFAT has no real owners or permissions to preserve.
    '-rlt',
    // exFAT timestamps can differ slightly from HFS+, which would otherwise recopy files.
    '--modify-window=1',
    // Files that would be overwritten or deleted are moved aside, never destroyed.
    '--delete',
    '--backup',
    `--backup-dir=${job.replacedDir}`,
    '--stats',
    ...job.excludes.map((pattern) => `--exclude=${pattern}`),
    // The trailing slashes mean "contents of", so paths never nest one level deeper.
    `${job.source.replace(/\/$/, '')}/`,
    `${job.dest.replace(/\/$/, '')}/`,
  ];
}

export function parseStat(output: string, label: string): number {
  const match = new RegExp(`^${label}: ([\\d,]+)`, 'm').exec(output);
  return match?.[1] ? Number(match[1].replaceAll(',', '')) : 0;
}

export function parseRegularFileCount(output: string): number {
  const match = /^Number of files: [\d,]+ \(([^)]*)\)/m.exec(output);
  const regular = match?.[1] ? /reg: ([\d,]+)/.exec(match[1]) : null;
  return regular?.[1] ? Number(regular[1].replaceAll(',', '')) : 0;
}

export function parseDryRun(output: string): Omit<FilesPlan, 'destinationExists' | 'replacedDir'> {
  const plan = {
    newFiles: 0,
    changedFiles: 0,
    deletedFiles: 0,
    sourceFiles: parseRegularFileCount(output),
    bytesToCopy: parseStat(output, 'Total transferred file size'),
    replacedSamples: [] as string[],
    newSamples: [] as string[],
  };
  for (const line of output.split('\n')) {
    if (line.startsWith('*deleting')) {
      const path = line.slice('*deleting'.length).trim();
      if (path.endsWith('/')) continue;
      plan.deletedFiles += 1;
      if (plan.replacedSamples.length < SAMPLE_LIMIT) plan.replacedSamples.push(path);
    } else if (/^>f/.test(line)) {
      const path = line.slice(12);
      if (line.slice(2, 11).startsWith('+')) {
        plan.newFiles += 1;
        if (plan.newSamples.length < SAMPLE_LIMIT) plan.newSamples.push(path);
      } else {
        plan.changedFiles += 1;
        if (plan.replacedSamples.length < SAMPLE_LIMIT) plan.replacedSamples.push(path);
      }
    }
  }
  return plan;
}

export async function dryRun(job: RsyncJob, signal?: AbortSignal) {
  const result = await exec(job.rsync, ['--dry-run', '--itemize-changes', ...baseArgs(job)], { signal });
  if (result.code !== 0 && result.code !== 24) {
    throw new Error(redact(`rsync dry run failed (${result.code}): ${result.stderr.trim()}`));
  }
  return parseDryRun(result.stdout);
}

export interface RsyncProgress {
  percent: number;
  rate: string;
  eta: string;
}

export function parseProgress(line: string): RsyncProgress | null {
  const match = /(\d+)%\s+(\S+\/s)\s+(\d+:\d{2}:\d{2})/.exec(line);
  return match ? { percent: Number(match[1]), rate: match[2]!, eta: match[3]! } : null;
}

export interface RsyncOutcome {
  /** 24 means a source file disappeared mid-run, which is harmless and retried next time. */
  code: number;
  filesCopied: number;
  filesDeleted: number;
  bytesCopied: number;
  stderr: string;
}

export async function copy(
  job: RsyncJob,
  onProgress: (progress: RsyncProgress) => void,
  signal?: AbortSignal,
): Promise<RsyncOutcome> {
  let pending = '';
  const result = await exec(job.rsync, ['--no-inc-recursive', '--info=progress2', ...baseArgs(job)], {
    signal,
    onStdout: (text) => {
      pending += text;
      const lines = pending.split(/[\r\n]/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const progress = parseProgress(line);
        if (progress) onProgress(progress);
      }
    },
  });
  return {
    code: result.code,
    filesCopied: parseStat(result.stdout, 'Number of regular files transferred'),
    filesDeleted: parseStat(result.stdout, 'Number of deleted files'),
    bytesCopied: parseStat(result.stdout, 'Total transferred file size'),
    stderr: redact(result.stderr.trim()),
  };
}
