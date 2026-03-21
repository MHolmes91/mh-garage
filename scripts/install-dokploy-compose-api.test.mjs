import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { execFileAsync } from './support.mjs';

test('compose api cli main persists ids after discovery and creation', async () => {
  const { main } = await import('./install-dokploy-compose-api.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, '.env');
  const operationLog = [];

  await writeFile(envFilePath, ['DOKPLOY_URL=https://dokploy.example.com', 'DOKPLOY_API_TOKEN=token-123', `ZROK_INSTANCE_DIR=${tempDir}`, ''].join('\n'));

  await main(['--env-file', envFilePath, '--prepared'], {
    stdout: { write() {} },
    stderr: { write() {} },
    fetchFn: async (url, options = {}) => {
      operationLog.push(['fetch', url, options.method ?? 'GET']);
      if (url.includes('/project.all')) return { ok: true, async json() { return { result: { data: { json: [] } } }; } };
      if (url.includes('/project.one') && options.method !== 'POST') return { ok: true, async json() { return { result: { data: { json: { environments: [] } } } }; } };
      const endpoint = url.split('/api/trpc/')[1];
      if (endpoint === 'project.create') return { ok: true, async json() { return { result: { data: { json: { projectId: 'project-1' } } } }; } };
      if (endpoint === 'environment.create') return { ok: true, async json() { return { result: { data: { json: { environmentId: 'env-1' } } } }; } };
      if (endpoint === 'compose.create') return { ok: true, async json() { return { result: { data: { json: { composeId: 'compose-1' } } } }; } };
      return { ok: true, async json() { return { result: { data: { json: {} } } }; } };
    },
    renderComposeBundle: async (instanceDirectoryPath) => {
      operationLog.push(['render', instanceDirectoryPath]);
      return { composeYaml: 'services: {}', composeEnv: 'NAME=value\n' };
    },
  });

  const envFileText = await readFile(envFilePath, 'utf8');
  assert.match(envFileText, /DOKPLOY_PROJECT_ID='project-1'/);
  assert.match(envFileText, /DOKPLOY_ENVIRONMENT_ID='env-1'/);
  assert.match(envFileText, /DOKPLOY_COMPOSE_ID='compose-1'/);
  assert.deepEqual(operationLog, [
    ['fetch', 'https://dokploy.example.com/api/trpc/project.all', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.create', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-1%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/environment.create', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-1%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.create', 'POST'],
    ['render', tempDir],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.update', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.deploy', 'POST'],
  ]);
});

test('compose api cli main persists discovered ids without creating resources', async () => {
  const { main } = await import('./install-dokploy-compose-api.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, '.env');
  const operationLog = [];

  await writeFile(envFilePath, ['DOKPLOY_URL=https://dokploy.example.com', 'DOKPLOY_API_TOKEN=token-123', `ZROK_INSTANCE_DIR=${tempDir}`, ''].join('\n'));

  await main(['--env-file', envFilePath, '--prepared'], {
    stdout: { write() {} },
    fetchFn: async (url, options = {}) => {
      operationLog.push(['fetch', url, options.method ?? 'GET']);
      if (url.includes('/project.all')) return { ok: true, async json() { return { result: { data: { json: [{ name: 'zrok', projectId: 'project-existing' }] } } }; } };
      if (url.includes('/project.one')) return { ok: true, async json() { return { result: { data: { json: { environments: [{ name: 'production', environmentId: 'env-existing', compose: [{ name: 'zrok-instance', appName: 'zrok-instance', composeId: 'compose-existing' }] }] } } } }; } };
      return { ok: true, async json() { return { result: { data: { json: {} } } }; } };
    },
    renderComposeBundle: async (instanceDirectoryPath) => {
      operationLog.push(['render', instanceDirectoryPath]);
      return { composeYaml: 'services: {}', composeEnv: 'NAME=value\n' };
    },
  });

  const envFileText = await readFile(envFilePath, 'utf8');
  assert.match(envFileText, /DOKPLOY_PROJECT_ID='project-existing'/);
  assert.match(envFileText, /DOKPLOY_ENVIRONMENT_ID='env-existing'/);
  assert.match(envFileText, /DOKPLOY_COMPOSE_ID='compose-existing'/);
  assert.deepEqual(operationLog, [
    ['fetch', 'https://dokploy.example.com/api/trpc/project.all', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-existing%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-existing%22%7D%7D', 'GET'],
    ['render', tempDir],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.update', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.deploy', 'POST'],
  ]);
});

test('compose api cli prints help output', async () => {
  const scriptPath = fileURLToPath(new URL('./install-dokploy-compose-api.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--help']);
  assert.match(stdout, /Usage: install-dokploy-compose-api\.js \[--env-file PATH\] \[--mode pause\|exit\] \[--prepared\]/);
  assert.equal(stderr, '');
});
