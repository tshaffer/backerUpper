import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, ItemConfig } from '../shared/types.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

/** Rejects a config that could write outside a backup folder or back a drive up onto itself. */
export function validateConfig(config: Config): void {
  const volumeIds = new Set(config.volumes.map((v) => v.id));
  const requireVolume = (id: string, context: string) => {
    if (!volumeIds.has(id)) throw new Error(`${context}: unknown volume "${id}"`);
  };
  const requireRelative = (path: string, context: string) => {
    if (!path || isAbsolute(path) || path.split('/').includes('..')) {
      throw new Error(`${context}: "${path}" must be a relative path inside the volume`);
    }
  };
  const seen = new Set<string>();
  for (const app of config.apps) {
    for (const item of app.items) {
      const context = `${app.id}/${item.id}`;
      if (seen.has(context)) throw new Error(`Duplicate item ${context}`);
      seen.add(context);
      if (item.type === 'mongo') {
        if (item.destinations.length === 0) throw new Error(`${context}: no destinations`);
        item.destinations.forEach((id) => requireVolume(id, context));
        requireRelative(item.root, context);
        if (!Number.isInteger(item.retention) || item.retention < 1) {
          throw new Error(`${context}: retention must be at least 1`);
        }
      } else {
        if (item.destVolumes.length === 0) throw new Error(`${context}: no destinations`);
        item.destVolumes.forEach((id) => requireVolume(id, context));
        if (item.sourceVolume) {
          requireVolume(item.sourceVolume, context);
          requireRelative(item.sourcePath, context);
          if (item.destVolumes.includes(item.sourceVolume)) {
            throw new Error(`${context}: a backup must not live on the same drive as its source`);
          }
        } else if (!isAbsolute(expandHome(item.sourcePath))) {
          throw new Error(`${context}: a source on this Mac needs an absolute path`);
        }
        requireRelative(item.destPath, context);
        requireRelative(item.replacedRoot, context);
      }
    }
  }
}

export function loadConfig(): Config {
  const path = process.env.BACKERUPPER_CONFIG ?? join(PROJECT_ROOT, 'config/backerupper.config.json');
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  validateConfig(config);
  return config;
}

export function itemKey(appId: string, itemId: string): string {
  return `${appId}/${itemId}`;
}

export function allItems(config: Config): { key: string; appName: string; item: ItemConfig }[] {
  return config.apps.flatMap((app) =>
    app.items.map((item) => ({ key: itemKey(app.id, item.id), appName: app.name, item })),
  );
}

/** The drives written to, which excludes a source drive. */
export function destinationVolumes(item: ItemConfig): string[] {
  return item.type === 'mongo' ? item.destinations : item.destVolumes;
}

export function itemVolumes(item: ItemConfig): string[] {
  if (item.type === 'mongo') return item.destinations;
  return item.sourceVolume ? [item.sourceVolume, ...item.destVolumes] : item.destVolumes;
}
