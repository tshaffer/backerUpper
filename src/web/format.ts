export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAge(iso?: string): string {
  if (!iso) return 'Never backed up here';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Backed up today';
  if (days === 1) return 'Backed up yesterday';
  return `Backed up ${days} days ago`;
}

export const count = (n: number, noun: string): string =>
  `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
