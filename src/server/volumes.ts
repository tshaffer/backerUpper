import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdir, rm, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VolumeConfig, VolumeStatus } from '../shared/types.js';
import { exec } from './exec.js';

const VOLUMES_ROOT = '/Volumes';
const CACHE_MS = 2000;

interface MountedVolume {
  uuid: string;
  mountPath: string;
  filesystem?: string;
}

async function readDiskInfo(mountPath: string): Promise<MountedVolume | null> {
  const info = await exec('/usr/sbin/diskutil', ['info', '-plist', mountPath]);
  if (info.code !== 0) return null;
  const json = await convertPlist(info.stdout);
  const parsed = JSON.parse(json) as { VolumeUUID?: string; FilesystemType?: string };
  if (!parsed.VolumeUUID) return null;
  return { uuid: parsed.VolumeUUID.toUpperCase(), mountPath, filesystem: parsed.FilesystemType };
}

async function convertPlist(plist: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']);
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => (out += text));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('plutil failed'))));
    child.stdin.end(plist);
  });
}

let cache: { at: number; volumes: MountedVolume[] } | null = null;

async function listMounted(force = false): Promise<MountedVolume[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.volumes;
  const names = await readdir(VOLUMES_ROOT);
  const found = await Promise.all(
    names.map((name) => readDiskInfo(join(VOLUMES_ROOT, name)).catch(() => null)),
  );
  const volumes = found.filter((v): v is MountedVolume => v !== null);
  cache = { at: Date.now(), volumes };
  return volumes;
}

/** Finds a drive by UUID, so a renamed drive still matches and a same-named one does not. */
export async function resolveVolume(volume: VolumeConfig): Promise<string | null> {
  const mounted = await listMounted(true);
  return mounted.find((v) => v.uuid === volume.uuid.toUpperCase())?.mountPath ?? null;
}

export async function volumeStatuses(configured: VolumeConfig[]): Promise<VolumeStatus[]> {
  const mounted = await listMounted();
  return Promise.all(
    configured.map(async (volume) => {
      const match = mounted.find((v) => v.uuid === volume.uuid.toUpperCase());
      const base = { id: volume.id, label: volume.label, uuid: volume.uuid };
      if (!match) return { ...base, mounted: false };
      return {
        ...base,
        mounted: true,
        mountPath: match.mountPath,
        filesystem: match.filesystem,
        readable: await isReadable(match.mountPath),
        freeBytes: await freeBytes(match.mountPath).catch(() => undefined),
      };
    }),
  );
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

/** Confirms this process can really write to the drive, then removes the probe file. */
export async function canWrite(mountPath: string): Promise<boolean> {
  const probe = join(mountPath, `.backerupper-probe-${randomBytes(4).toString('hex')}`);
  try {
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function ejectVolume(mountPath: string): Promise<{ ok: boolean; message: string }> {
  const result = await exec('/usr/sbin/diskutil', ['eject', mountPath]);
  cache = null;
  return { ok: result.code === 0, message: (result.stdout + result.stderr).trim() };
}
