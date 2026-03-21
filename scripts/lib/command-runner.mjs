import { spawn } from 'node:child_process';

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command exited with code ${code}`));
    });
  });
}

async function defaultExec(command, args, options) {
  await runCommand(command, args, undefined, options);
}

export async function checkCommandExists(command, execFn = defaultExec) {
  try {
    await execFn('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(
  command,
  args = [],
  spawnFn = spawn,
  options = { stdio: 'inherit' },
) {
  const child = spawnFn(command, args, options);
  await waitForChild(child);
}

export async function runCommandCapture(command, args = [], spawnFn = spawn, options = {}) {
  const child = spawnFn(command, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
  });

  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  await waitForChild(child);
  return { stdout, stderr };
}

export function extractLastNonEmptyLine(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}
