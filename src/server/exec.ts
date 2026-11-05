import { spawn } from 'node:child_process';

export interface ExecOptions {
  signal?: AbortSignal;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Removes credentials from anything that may reach a log or the browser. */
export function redact(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s"']+@/g, '$1<credentials>@');
}

/** Runs a program directly, without a shell, and always resolves with its exit code. */
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
      options.onStderr?.(text);
    });
    const abort = () => child.kill('SIGTERM');
    if (options.signal?.aborted) abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}
