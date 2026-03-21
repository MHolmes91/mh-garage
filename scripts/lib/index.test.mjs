import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFakeChildProcess } from '../support.mjs';

test('parseInstallArgs reads env file, mode, and deploy method', async () => {
  const { parseInstallArgs } = await import('./index.mjs');

  assert.deepEqual(
    parseInstallArgs(['--env-file', 'custom.env', '--mode', 'exit', '--deploy-method', 'dokploy-compose-api']),
    { envFile: 'custom.env', mode: 'exit', deployMethod: 'dokploy-compose-api' },
  );
});

test('parseInstallArgs leaves mode and deploy method unset when omitted', async () => {
  const { parseInstallArgs } = await import('./index.mjs');

  assert.deepEqual(parseInstallArgs(['--env-file', 'custom.env']), {
    envFile: 'custom.env',
    mode: undefined,
    deployMethod: undefined,
  });
});

test('parseInstallArgs rejects unsupported enum values', async () => {
  const { parseInstallArgs } = await import('./index.mjs');

  assert.throws(() => parseInstallArgs(['--mode', 'wait']), /Invalid mode: wait\. Allowed values: pause, exit/);
  assert.throws(
    () => parseInstallArgs(['--deploy-method', 'docker']),
    /Invalid deploy method: docker\. Allowed values: raw, dokploy-compose-api/,
  );
});

test('parseComposeApiArgs reads env file, mode, and prepared flag', async () => {
  const { parseComposeApiArgs } = await import('./index.mjs');

  assert.deepEqual(parseComposeApiArgs(['--env-file', 'custom.env', '--mode', 'exit', '--prepared']), {
    envFile: 'custom.env',
    mode: 'exit',
    prepared: true,
  });
});

test('parseComposeApiArgs rejects unsupported mode values', async () => {
  const { parseComposeApiArgs } = await import('./index.mjs');

  assert.throws(() => parseComposeApiArgs(['--mode', 'wait']), /Invalid mode: wait\. Allowed values: pause, exit/);
});

test('quoteEnvValue escapes single quotes and wraps values', async () => {
  const { quoteEnvValue } = await import('./index.mjs');
  assert.equal(quoteEnvValue("a'b c"), "'a'\"'\"'b c'");
});

test('upsertEnvText replaces existing values and appends missing keys', async () => {
  const { upsertEnvText } = await import('./index.mjs');

  assert.equal(upsertEnvText("KEEP='1'\nNAME='old'\n", 'NAME', "new'value"), "KEEP='1'\nNAME='new'\"'\"'value'\n");
  assert.equal(upsertEnvText("KEEP='1'\n", 'NAME', 'fresh value'), "KEEP='1'\nNAME='fresh value'\n");
});

test('loadEnvFile reads quoted values from disk', async () => {
  const { loadEnvFile } = await import('./index.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, '.env');

  await writeFile(envFilePath, "NAME='hello world'\nQUOTE='a'\"'\"'b'\nPLAIN=value\n");

  assert.deepEqual(await loadEnvFile(envFilePath), {
    NAME: 'hello world',
    QUOTE: "a'b",
    PLAIN: 'value',
  });
});

test('createEnvState sets variables and persists them', async () => {
  const { createEnvState } = await import('./index.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, '.env');

  await writeFile(envFilePath, "EXISTING='1'\n");

  const envState = await createEnvState(envFilePath);
  assert.equal(envState.get('EXISTING'), '1');

  await envState.setVar('NAME', "new'value");

  assert.equal(envState.get('NAME'), "new'value");
  assert.equal(await readFile(envFilePath, 'utf8'), "EXISTING='1'\nNAME='new'\"'\"'value'\n");
});

test('ensureEnvFile creates parent directories for nested env paths', async () => {
  const { ensureEnvFile } = await import('./index.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'nested', 'deploy.env');

  await ensureEnvFile(envFilePath);
  assert.equal(await readFile(envFilePath, 'utf8'), '');
});

test('validate helpers accept supported values', async () => {
  const { validateMode, validateDeployMethod, validateComposeApiMode } = await import('./index.mjs');

  assert.equal(validateMode('pause'), 'pause');
  assert.equal(validateMode('exit'), 'exit');
  assert.equal(validateDeployMethod('raw'), 'raw');
  assert.equal(validateDeployMethod('dokploy-compose-api'), 'dokploy-compose-api');
  assert.equal(validateComposeApiMode('pause'), 'pause');
  assert.equal(validateComposeApiMode('exit'), 'exit');
});

test('validate helpers reject unsupported values', async () => {
  const { validateMode, validateDeployMethod, validateComposeApiMode } = await import('./index.mjs');

  assert.throws(() => validateMode('wait'), /Invalid mode: wait\. Allowed values: pause, exit/);
  assert.throws(() => validateDeployMethod('docker'), /Invalid deploy method: docker\. Allowed values: raw, dokploy-compose-api/);
  assert.throws(() => validateComposeApiMode('wait'), /Invalid compose api mode: wait\. Allowed values: pause, exit/);
});

test('checkCommandExists uses injected executor and returns true on success', async () => {
  const { checkCommandExists } = await import('./index.mjs');
  const commandCalls = [];

  const commandExists = await checkCommandExists('docker', async (...argumentsList) => {
    commandCalls.push(argumentsList);
    return { code: 0 };
  });

  assert.equal(commandExists, true);
  assert.deepEqual(commandCalls, [[
    'sh',
    ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', 'docker'],
    { stdio: 'ignore' },
  ]]);
});

test('checkCommandExists returns false when executor rejects', async () => {
  const { checkCommandExists } = await import('./index.mjs');
  const commandExists = await checkCommandExists('docker', async () => {
    throw new Error('missing');
  });

  assert.equal(commandExists, false);
});

test('runCommand uses inherited stdio and resolves on exit code 0', async () => {
  const { runCommand } = await import('./index.mjs');
  let spawnCall;

  await runCommand('docker', ['compose', 'up'], (command, args, options) => {
    spawnCall = { command, args, options };
    const childProcess = createFakeChildProcess();
    process.nextTick(() => childProcess.emit('close', 0));
    return childProcess;
  });

  assert.deepEqual(spawnCall, { command: 'docker', args: ['compose', 'up'], options: { stdio: 'inherit' } });
});

test('runCommandCapture pipes output and returns collected text', async () => {
  const { runCommandCapture } = await import('./index.mjs');
  let spawnCall;

  const captureResult = await runCommandCapture('docker', ['ps'], (command, args, options) => {
    spawnCall = { command, args, options };
    const childProcess = createFakeChildProcess();
    process.nextTick(() => {
      childProcess.stdout.emit('data', 'stdout line');
      childProcess.stderr.emit('data', Buffer.from('stderr line'));
      childProcess.emit('close', 0);
    });
    return childProcess;
  });

  assert.deepEqual(spawnCall, { command: 'docker', args: ['ps'], options: { stdio: ['ignore', 'pipe', 'pipe'] } });
  assert.deepEqual(captureResult, { stdout: 'stdout line', stderr: 'stderr line' });
});

test('runCommand rejects on non-zero exit', async () => {
  const { runCommand } = await import('./index.mjs');

  await assert.rejects(runCommand('docker', ['compose', 'up'], () => {
    const childProcess = createFakeChildProcess();
    process.nextTick(() => childProcess.emit('close', 1));
    return childProcess;
  }), /Command exited with code 1/);
});

test('runCommandCapture rejects on child error', async () => {
  const { runCommandCapture } = await import('./index.mjs');

  await assert.rejects(runCommandCapture('docker', ['ps'], () => {
    const childProcess = createFakeChildProcess();
    process.nextTick(() => childProcess.emit('error', new Error('spawn failed')));
    return childProcess;
  }), /spawn failed/);
});

test('requireRootLinux rejects non-root users and non-Linux hosts', async () => {
  const { requireRootLinux } = await import('./index.mjs');

  assert.throws(() => requireRootLinux({ uid: 1000, platform: 'Linux' }), /This script must run as root\./);
  assert.throws(() => requireRootLinux({ uid: 0, platform: 'Darwin' }), /This script only supports Linux hosts\./);
});

test('lib no longer exports ensureNodeForDokployCli', async () => {
  const libModule = await import('./index.mjs');
  assert.equal('ensureNodeForDokployCli' in libModule, false);
});
