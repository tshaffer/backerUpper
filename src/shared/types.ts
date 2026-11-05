// Types shared by the API and the web UI.

export interface VolumeConfig {
  id: string;
  label: string;
  uuid: string;
}

export interface MongoItemConfig {
  id: string;
  type: 'mongo';
  label: string;
  note?: string;
  defaultSelected: boolean;
  envFile: string;
  envKey: string;
  database: string;
  root: string;
  destinations: string[];
  retention: number;
}

export interface FilesItemConfig {
  id: string;
  type: 'files';
  label: string;
  note?: string;
  defaultSelected: boolean;
  sourceVolume: string;
  sourcePath: string;
  destVolume: string;
  destPath: string;
  replacedRoot: string;
}

export type ItemConfig = MongoItemConfig | FilesItemConfig;

export interface AppConfig {
  id: string;
  name: string;
  items: ItemConfig[];
}

export interface Config {
  tools: { rsync: string; mongodump: string };
  excludes: string[];
  guard: { replacedPercent: number; replacedMinFiles: number };
  /** Space that must remain free on a destination after a backup. */
  freeSpaceMarginMB: number;
  volumes: VolumeConfig[];
  apps: AppConfig[];
}

export interface VolumeStatus {
  id: string;
  label: string;
  uuid: string;
  mounted: boolean;
  mountPath?: string;
  filesystem?: string;
  freeBytes?: number;
  /** False when macOS refuses to list the drive (usually a privacy permission). */
  readable?: boolean;
}

export interface ItemView {
  key: string;
  label: string;
  note?: string;
  type: 'mongo' | 'files';
  defaultSelected: boolean;
  volumes: string[];
  lastBackupAt?: string;
}

export interface AppView {
  id: string;
  name: string;
  items: ItemView[];
}

export interface FilesPlan {
  newFiles: number;
  changedFiles: number;
  deletedFiles: number;
  sourceFiles: number;
  bytesToCopy: number;
  /** Example paths that would be moved into the _replaced folder. */
  replacedSamples: string[];
  newSamples: string[];
  destinationExists: boolean;
  replacedDir: string;
}

export interface MongoPlan {
  collections: number;
  documents: number;
  destinations: string[];
}

export interface PlanItem {
  key: string;
  label: string;
  type: 'mongo' | 'files';
  blockers: string[];
  warnings: string[];
  guardTriggered: boolean;
  files?: FilesPlan;
  mongo?: MongoPlan;
}

export interface Plan {
  id: string;
  createdAt: string;
  items: PlanItem[];
  blockers: string[];
  guardTriggered: boolean;
}

export type ItemState = 'pending' | 'running' | 'ok' | 'warning' | 'failed' | 'cancelled';

export interface JobItem {
  key: string;
  label: string;
  state: ItemState;
  detail?: string;
  percent?: number;
  rate?: string;
  eta?: string;
}

export interface Job {
  id: string;
  kind: 'plan' | 'run';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  items: JobItem[];
  log: string[];
  plan?: Plan;
  manifestWarnings?: string[];
}

export interface RunItemRecord {
  key: string;
  label: string;
  state: ItemState;
  detail?: string;
}

export interface RunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  items: RunItemRecord[];
}

export interface AppState {
  apps: AppView[];
  volumes: VolumeStatus[];
  job: Job | null;
}
