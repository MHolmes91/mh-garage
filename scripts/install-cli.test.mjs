import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { execFileAsync } from './support.mjs';

test('install cli main runs raw deployment flow and persists generated artifacts', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'deploy.env');
  const instanceDirectoryPath = join(tempDir, 'instance');
  const eventLog = [];
  const outputChunks = [];

  await writeFile(envFilePath, [`ZROK_INSTANCE_DIR=${instanceDirectoryPath}`, 'INSTALL_DOKPLOY_CLI=false', ''].join('\n'));

  await main(['--env-file', envFilePath], {
    stdout: { write(chunk) { outputChunks.push(chunk); } },
    stderr: { write(chunk) { outputChunks.push(chunk); } },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => { const values = ['admin-token-123', 'ziti-password-456']; return () => values.shift(); })(),
    promptForValue: async ({ key }) => {
      if (key === 'DOKPLOY_DOMAIN') return 'dokploy.example.com';
      if (key === 'ZROK_DOMAIN') return 'zrok.example.com';
      if (key === 'ZROK_USER_EMAIL') return 'admin@example.com';
      if (key === 'ZROK_USER_PWD') return 'hunter2';
      throw new Error(`Unexpected prompt for ${key}`);
    },
    pauseOrExit: async (message) => { eventLog.push(['pause', message]); },
    ensureDokployInstalled: async () => { eventLog.push(['install-dokploy']); },
    waitForDokploy: async () => { eventLog.push(['wait-dokploy']); },
    getPublicIp: async () => '203.0.113.10',
    hostResolvesTo: async (host, ip) => { eventLog.push(['resolve', host, ip]); return true; },
    httpsOk: async (url) => { eventLog.push(['https', url]); return true; },
    fetchZrokProject: async (targetDirectoryPath) => { eventLog.push(['fetch-project', targetDirectoryPath]); await writeFile(join(targetDirectoryPath, 'compose.yml'), 'services:\n  zrok-controller: {}\n'); },
    deployRaw: async (targetDirectoryPath) => { eventLog.push(['deploy-raw', targetDirectoryPath]); },
    createZrokAccount: async ({ email, instanceDir: targetDirectoryPath }) => { eventLog.push(['create-account', email, targetDirectoryPath]); return 'account-token-789'; },
  });

  const envFileText = await readFile(envFilePath, 'utf8');
  assert.match(envFileText, /DOKPLOY_URL='https:\/\/dokploy\.example\.com'/);
  assert.match(envFileText, /ZROK_ADMIN_TOKEN='admin-token-123'/);
  assert.match(envFileText, /ZITI_PWD='ziti-password-456'/);
  assert.match(envFileText, /ZROK_ACCOUNT_TOKEN='account-token-789'/);
  assert.match(await readFile(join(instanceDirectoryPath, 'zrok-frontend-config.yml.envsubst'), 'utf8'), /host_match: \$\{ZROK_DNS_ZONE\}/);
  assert.match(await readFile(join(instanceDirectoryPath, '.env'), 'utf8'), /ZROK_DNS_ZONE=zrok\.example\.com/);
  assert.match(await readFile(join(instanceDirectoryPath, 'compose.dokploy.yml'), 'utf8'), /dokploy-network:/);
  assert.match(await readFile(join(instanceDirectoryPath, '.installer-state/zrok-account-token'), 'utf8'), /account-token-789/);
  assert.deepEqual(eventLog, [
    ['install-dokploy'],
    ['wait-dokploy'],
    ['pause', 'Manual checkpoint: open http://203.0.113.10:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.'],
    ['resolve', 'dokploy.example.com', '203.0.113.10'],
    ['https', 'https://dokploy.example.com'],
    ['fetch-project', instanceDirectoryPath],
    ['resolve', 'zrok.example.com', '203.0.113.10'],
    ['resolve', 'probe.zrok.example.com', '203.0.113.10'],
    ['deploy-raw', instanceDirectoryPath],
    ['pause', `Next manual checkpoint: the script is ready to create the first zrok account using admin@example.com. If you want to change the email or password, edit ${envFilePath} now.`],
    ['create-account', 'admin@example.com', instanceDirectoryPath],
  ]);
  assert.match(outputChunks.join(''), /Detected public IP: 203\.0\.113\.10/);
  assert.match(outputChunks.join(''), /zrok controller URL: https:\/\/zrok\.example\.com/);
});

test('install cli main delegates compose api deployment and installs cli when missing', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'deploy.env');
  const instanceDirectoryPath = join(tempDir, 'instance');
  const eventLog = [];
  const checkedCommands = [];

  await writeFile(envFilePath, ['DOKPLOY_DOMAIN=dokploy.example.com', 'DOKPLOY_URL=https://dokploy.example.com', 'DOKPLOY_API_TOKEN=token-123', 'ZROK_DOMAIN=zrok.example.com', 'ZROK_USER_EMAIL=admin@example.com', 'ZROK_USER_PWD=hunter2', `ZROK_INSTANCE_DIR=${instanceDirectoryPath}`, ''].join('\n'));

  await main(['--env-file', envFilePath, '--deploy-method', 'dokploy-compose-api'], {
    stdout: { write() {} },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => { const values = ['admin-token-123', 'ziti-password-456']; return () => values.shift(); })(),
    checkCommandExists: async (command) => { checkedCommands.push(command); return command !== 'dokploy'; },
    ensureDokployInstalled: async () => { eventLog.push(['install-dokploy']); },
    waitForDokploy: async () => { eventLog.push(['wait-dokploy']); },
    getPublicIp: async () => '',
    httpsOk: async () => true,
    installDokployCli: async () => { eventLog.push(['install-dokploy-cli']); },
    authenticateDokployCli: async (url, token) => { eventLog.push(['authenticate-dokploy-cli', url, token]); },
    fetchZrokProject: async (targetDirectoryPath) => { eventLog.push(['fetch-project', targetDirectoryPath]); await writeFile(join(targetDirectoryPath, 'compose.yml'), 'services:\n  zrok-controller: {}\n'); },
    delegateComposeApi: async (argumentsList) => { eventLog.push(['delegate-compose-api', argumentsList]); },
    createZrokAccount: async () => 'account-token-789',
    pauseOrExit: async (message) => { eventLog.push(['pause', message]); },
    hostResolvesTo: async () => true,
  });

  assert.deepEqual(eventLog, [
    ['install-dokploy'],
    ['wait-dokploy'],
    ['pause', 'Manual checkpoint: open http://127.0.0.1:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.'],
    ['install-dokploy-cli'],
    ['authenticate-dokploy-cli', 'https://dokploy.example.com', 'token-123'],
    ['fetch-project', instanceDirectoryPath],
    ['delegate-compose-api', ['--env-file', envFilePath, '--mode', 'pause', '--prepared']],
    ['pause', `Next manual checkpoint: the script is ready to create the first zrok account using admin@example.com. If you want to change the email or password, edit ${envFilePath} now.`],
  ]);
  assert.deepEqual(checkedCommands, ['dokploy']);
});

test('install cli main lets cli mode override MODE from env file', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'mode.env');
  const outputChunks = [];

  await writeFile(envFilePath, "MODE='pause'\n");

  await assert.rejects(main(['--env-file', envFilePath, '--mode', 'exit'], {
    stdout: { write(chunk) { outputChunks.push(chunk); } },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    promptForValue: async () => { throw new Error('prompt should not run'); },
  }), /Installer exited at a manual checkpoint/);

  assert.match(outputChunks.join(''), /Manual input required for DOKPLOY_DOMAIN/);
});

test('install cli main honors MODE and DEPLOY_METHOD from env file when CLI omits them', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'env-precedence.env');
  const outputChunks = [];

  await writeFile(envFilePath, "MODE='exit'\nDEPLOY_METHOD='dokploy-compose-api'\n");

  await assert.rejects(main(['--env-file', envFilePath], {
    stdout: { write(chunk) { outputChunks.push(chunk); } },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    promptForValue: async () => { throw new Error('prompt should not run'); },
  }), /Installer exited at a manual checkpoint/);

  const envFileText = await readFile(envFilePath, 'utf8');
  assert.match(outputChunks.join(''), /Manual input required for DOKPLOY_DOMAIN/);
  assert.match(envFileText, /DEPLOY_METHOD='dokploy-compose-api'/);
});

test('install cli main skips Dokploy CLI install when dokploy already exists', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'existing-dokploy.env');
  const instanceDirectoryPath = join(tempDir, 'instance');
  const eventLog = [];
  const checkedCommands = [];

  await writeFile(envFilePath, ['DOKPLOY_DOMAIN=dokploy.example.com', 'DOKPLOY_URL=https://dokploy.example.com', 'DOKPLOY_API_TOKEN=token-123', 'ZROK_DOMAIN=zrok.example.com', 'ZROK_USER_EMAIL=admin@example.com', 'ZROK_USER_PWD=hunter2', `ZROK_INSTANCE_DIR=${instanceDirectoryPath}`, ''].join('\n'));

  await main(['--env-file', envFilePath, '--deploy-method', 'dokploy-compose-api'], {
    stdout: { write() {} },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => { const values = ['admin-token-123', 'ziti-password-456']; return () => values.shift(); })(),
    checkCommandExists: async (command) => { checkedCommands.push(command); return true; },
    ensureDokployInstalled: async () => {},
    waitForDokploy: async () => {},
    getPublicIp: async () => '',
    httpsOk: async () => true,
    installDokployCli: async () => { eventLog.push(['install-dokploy-cli']); },
    authenticateDokployCli: async () => {},
    fetchZrokProject: async (targetDirectoryPath) => { await writeFile(join(targetDirectoryPath, 'compose.yml'), 'services:\n  zrok-controller: {}\n'); },
    delegateComposeApi: async () => {},
    createZrokAccount: async () => 'account-token-789',
    pauseOrExit: async () => {},
    hostResolvesTo: async () => true,
  });

  assert.deepEqual(eventLog, []);
  assert.deepEqual(checkedCommands, ['dokploy']);
});

test('install cli main persists existing zrok account token to state file and summary', async () => {
  const { main } = await import('./install.js');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFilePath = join(tempDir, 'existing-token.env');
  const instanceDirectoryPath = join(tempDir, 'instance');
  const outputChunks = [];
  const eventLog = [];

  await writeFile(envFilePath, ['DOKPLOY_DOMAIN=dokploy.example.com', 'DOKPLOY_URL=https://dokploy.example.com', 'ZROK_DOMAIN=zrok.example.com', 'ZROK_USER_EMAIL=admin@example.com', 'ZROK_USER_PWD=hunter2', 'ZROK_ACCOUNT_TOKEN=account-token-789', 'INSTALL_DOKPLOY_CLI=false', `ZROK_INSTANCE_DIR=${instanceDirectoryPath}`, ''].join('\n'));

  await main(['--env-file', envFilePath], {
    stdout: { write(chunk) { outputChunks.push(chunk); } },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => { const values = ['admin-token-123', 'ziti-password-456']; return () => values.shift(); })(),
    promptForValue: async ({ key }) => { throw new Error(`Unexpected prompt for ${key}`); },
    pauseOrExit: async (message) => { eventLog.push(['pause', message]); },
    ensureDokployInstalled: async () => { eventLog.push(['install-dokploy']); },
    waitForDokploy: async () => { eventLog.push(['wait-dokploy']); },
    getPublicIp: async () => '203.0.113.10',
    hostResolvesTo: async () => true,
    httpsOk: async () => true,
    fetchZrokProject: async (targetDirectoryPath) => { await writeFile(join(targetDirectoryPath, 'compose.yml'), 'services:\n  zrok-controller: {}\n'); },
    deployRaw: async () => {},
    createZrokAccount: async () => { throw new Error('should not create account'); },
  });

  assert.match(await readFile(join(instanceDirectoryPath, '.installer-state/zrok-account-token'), 'utf8'), /account-token-789/);
  assert.match(outputChunks.join(''), /zrok account token file: /);
  assert.equal(eventLog.some((entry) => entry[0] === 'pause' && String(entry[1]).includes('ready to create the first zrok account')), false);
});

test('install cli prints help output', async () => {
  const scriptPath = fileURLToPath(new URL('./install.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--help']);
  assert.match(stdout, /Usage: install\.js \[--env-file PATH\] \[--mode pause\|exit\] \[--deploy-method raw\|dokploy-compose-api\]/);
  assert.equal(stderr, '');
});
