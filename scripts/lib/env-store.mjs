import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function parseEnvValue(value) {
  if (value.startsWith("'")) {
    return value.slice(1, -1).replaceAll(`'"'"'`, "'");
  }

  return value;
}

export function quoteEnvValue(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function upsertEnvText(text, key, value) {
  const line = `${key}=${quoteEnvValue(value)}`;
  const lines = text.split('\n');
  let found = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(`${key}=`)) {
      lines[index] = line;
      found = true;
    }
  }

  if (!found) {
    if (lines.at(-1) === '') {
      lines.splice(-1, 0, line);
    } else {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

export async function ensureEnvFile(envFile) {
  const parentDir = dirname(envFile);
  if (parentDir && parentDir !== '.') {
    await mkdir(parentDir, { recursive: true });
  }

  try {
    await access(envFile);
  } catch {
    await writeFile(envFile, '');
  }
}

export async function loadEnvFile(envFile) {
  await ensureEnvFile(envFile);

  const text = await readFile(envFile, 'utf8');
  const entries = {};

  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    entries[key] = parseEnvValue(value);
  }

  return entries;
}

export async function createEnvState(envFile) {
  const entries = await loadEnvFile(envFile);
  const values = new Map(Object.entries(entries));

  return {
    get(key) {
      return values.get(key);
    },

    async setVar(key, value) {
      const stringValue = String(value);
      values.set(key, stringValue);

      let text = await readFile(envFile, 'utf8');
      text = upsertEnvText(text, key, stringValue);
      await writeFile(envFile, text);
    },
  };
}
