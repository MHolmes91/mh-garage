#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  checkCommandExists,
  createEnvState,
  extractLastNonEmptyLine,
  parseInstallArgs,
  renderInstallerArtifacts,
  requireRootLinux,
  runCommand,
  runCommandCapture,
} from './lib.mjs';

const HELP_TEXT = `Usage: install.js [--env-file PATH] [--mode pause|exit] [--deploy-method raw|dokploy-compose-api]

Options:
  --env-file PATH   Load and persist variables in this env file
  --mode MODE       pause (default) or exit when manual input is needed
  --deploy-method   raw (default) or dokploy-compose-api
  --help            Show this help message
`;

const DEFAULTS = {
  INSTALL_DOKPLOY_CLI: 'true',
  ZROK_INSTANCE_DIR: '/opt/zrok-instance',
  TRAEFIK_CERT_RESOLVER: 'letsencrypt',
  ZROK_CTRL_PORT: '18080',
  ZROK_FRONTEND_INTERNAL_PORT: '8080',
  ZROK_PUBLIC_HTTPS_PORT: '443',
  ZROK_OAUTH_PORT: '8081',
  ZITI_CTRL_ADVERTISED_PORT: '1443',
  ZITI_ROUTER_PORT: '3022',
};

class GracefulExit extends Error {
  constructor() {
    super('Installer exited at a manual checkpoint.');
  }
}

function log(stdout, message) {
  stdout.write(`\n==> ${message}\n`);
}

function note(stdout, message) {
  stdout.write(` -> ${message}\n`);
}

function envSnapshot(envState) {
  return Object.fromEntries([
    'INSTALL_DOKPLOY_CLI',
    'DOKPLOY_DOMAIN',
    'DOKPLOY_URL',
    'DOKPLOY_API_TOKEN',
    'DOKPLOY_VERSION',
    'ADVERTISE_ADDR',
    'DOCKER_SWARM_INIT_ARGS',
    'DEPLOY_METHOD',
    'ZROK_DOMAIN',
    'ZROK_INSTANCE_DIR',
    'TRAEFIK_CERT_RESOLVER',
    'ZROK_CTRL_PORT',
    'ZROK_FRONTEND_INTERNAL_PORT',
    'ZROK_PUBLIC_HTTPS_PORT',
    'ZROK_OAUTH_PORT',
    'ZITI_CTRL_ADVERTISED_PORT',
    'ZITI_ROUTER_PORT',
    'ZROK_ADMIN_TOKEN',
    'ZITI_PWD',
    'ZROK_USER_EMAIL',
    'ZROK_USER_PWD',
    'ZROK_ACCOUNT_TOKEN',
    'DOKPLOY_COMPOSE_APP_NAME',
  ].map((key) => [key, envState.get(key) ?? '']));
}

async function setIfMissing(envState, key, value) {
  if (!envState.get(key)) {
    await envState.setVar(key, value);
  }
}

function createRandomToken() {
  return randomBytes(64).toString('base64').replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 40);
}

async function defaultPromptForValue({ prompt, defaultValue = '', secret = false, stdin = process.stdin, stdout = process.stdout }) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(`${prompt}${suffix}: `, { hideEchoBack: secret });
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

async function defaultPauseOrExit({ message, mode, stdin = process.stdin, stdout = process.stdout }) {
  stdout.write(`\n${message}\n`);
  if (mode === 'pause') {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      await rl.question('Press Enter once this is done to continue. ');
      return;
    } finally {
      rl.close();
    }
  }

  stdout.write('Exiting now. Rerun the script after finishing that step.\n');
  throw new GracefulExit();
}

async function waitForHttp(url, attempts = 60, sleepMs = 2000, fetchFn = fetch) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(url);
      if (response.ok) {
        return true;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }

  return false;
}

async function defaultEnsureDokployInstalled(env, stdout) {
  try {
    await runCommandCapture('docker', ['service', 'inspect', 'dokploy']);
    note(stdout, 'Dokploy service already exists');
    return;
  } catch {}

  log(stdout, 'Installing Dokploy');
  const extraEnv = {
    ...process.env,
    DOKPLOY_VERSION: env.DOKPLOY_VERSION || 'latest',
  };

  if (env.ADVERTISE_ADDR) {
    extraEnv.ADVERTISE_ADDR = env.ADVERTISE_ADDR;
  }
  if (env.DOCKER_SWARM_INIT_ARGS) {
    extraEnv.DOCKER_SWARM_INIT_ARGS = env.DOCKER_SWARM_INIT_ARGS;
  }

  await runCommand('sh', ['-c', 'curl -sSL https://dokploy.com/install.sh | sh'], undefined, {
    stdio: 'inherit',
    env: extraEnv,
  });
}

async function defaultWaitForDokploy(stdout) {
  log(stdout, 'Waiting for Dokploy panel');
  if (await waitForHttp('http://127.0.0.1:3000', 90, 2000)) {
    note(stdout, 'Dokploy is reachable on http://127.0.0.1:3000');
    return;
  }

  throw new Error('Dokploy did not become reachable on port 3000 in time.');
}

async function defaultGetPublicIp() {
  for (const url of ['https://ifconfig.io', 'https://icanhazip.com', 'https://ipecho.net/plain']) {
    try {
      const response = await fetch(url, { headers: { Accept: 'text/plain' } });
      const ip = (await response.text()).trim();
      if (ip) {
        return ip;
      }
    } catch {}
  }

  return '';
}

async function defaultHostResolvesTo(host, expectedIp) {
  try {
    const results = await lookup(host, { all: true, family: 4 });
    return results.some((entry) => entry.address === expectedIp);
  } catch {
    return false;
  }
}

async function defaultHttpsOk(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return response.ok;
  } catch {
    return false;
  }
}

async function defaultInstallDokployCli(stdout) {
  log(stdout, 'Installing Dokploy CLI');
  await runCommand('npm', ['install', '-g', '@dokploy/cli']);
}

async function defaultAuthenticateDokployCli(stdout, url, token) {
  log(stdout, 'Authenticating Dokploy CLI');
  await runCommand('dokploy', ['authenticate', '-u', url, '-t', token]);
}

async function defaultFetchZrokProject(stdout, instanceDir) {
  try {
    await access(`${instanceDir}/compose.yml`);
    note(stdout, `zrok instance project already exists at ${instanceDir}`);
    return;
  } catch {}

  log(stdout, 'Fetching the official zrok instance project');
  await mkdir(instanceDir, { recursive: true });
  await runCommand('sh', ['-c', 'curl -fsSL https://get.openziti.io/zrok-instance/fetch.bash | bash'], undefined, {
    stdio: 'inherit',
    cwd: instanceDir,
  });
}

async function defaultDeployRaw(stdout, instanceDir) {
  log(stdout, 'Deploying the zrok stack');
  await runCommand('docker', ['network', 'inspect', 'dokploy-network']);
  await runCommand('docker', ['compose', '-f', 'compose.yml', '-f', 'compose.dokploy.yml', 'up', '-d', '--build'], undefined, {
    stdio: 'inherit',
    cwd: instanceDir,
  });
}

async function defaultDelegateComposeApi(stdout, args) {
  log(stdout, 'Delegating zrok deployment to Dokploy Compose API helper');
  const helperPath = fileURLToPath(new URL('./install-dokploy-compose-api.js', import.meta.url));
  await runCommand(process.execPath, [helperPath, ...args]);
}

async function defaultCreateZrokAccount(env) {
  let output;

  if (env.DEPLOY_METHOD === 'dokploy-compose-api') {
    const { stdout: containerStdout } = await runCommandCapture('docker', [
      'ps',
      '-q',
      '--filter', `label=com.docker.compose.project=${env.DOKPLOY_COMPOSE_APP_NAME || 'zrok-instance'}`,
      '--filter', 'label=com.docker.compose.service=zrok-controller',
    ]);
    const containerId = extractLastNonEmptyLine(containerStdout);
    if (!containerId) {
      throw new Error('Could not find the Dokploy-managed zrok controller container.');
    }
    output = (await runCommandCapture('docker', [
      'exec',
      containerId,
      'bash',
      '-lc',
      'zrok admin create account "$ZROK_USER_EMAIL" "$ZROK_USER_PWD"',
    ], undefined, {
      env: {
        ...process.env,
        ZROK_USER_EMAIL: env.ZROK_USER_EMAIL,
        ZROK_USER_PWD: env.ZROK_USER_PWD,
      },
    })).stdout;
  } else {
    output = (await runCommandCapture('docker', [
      'compose',
      'exec',
      '-T',
      'zrok-controller',
      'bash',
      '-lc',
      'zrok admin create account "$ZROK_USER_EMAIL" "$ZROK_USER_PWD"',
    ], undefined, {
      cwd: env.ZROK_INSTANCE_DIR,
      env: {
        ...process.env,
        ZROK_USER_EMAIL: env.ZROK_USER_EMAIL,
        ZROK_USER_PWD: env.ZROK_USER_PWD,
      },
    })).stdout;
  }

  const token = extractLastNonEmptyLine(output);
  if (!token) {
    throw new Error(`Failed to capture the zrok account token.\n${output}`.trim());
  }

  return token;
}

async function ensurePromptedValue(envState, env, key, prompt, options, dependencies) {
  if (env[key]) {
    return env[key];
  }

  if (options.mode === 'exit') {
    dependencies.stdout.write(`\nManual input required for ${key}. Add it to ${options.envFile} and rerun.\n`);
    throw new GracefulExit();
  }

  const value = await dependencies.promptForValue({
    key,
    prompt,
    defaultValue: options.defaultValue,
    secret: options.secret,
    envFile: options.envFile,
    stdin: dependencies.stdin,
    stdout: dependencies.stdout,
  });

  if (!value) {
    return ensurePromptedValue(envState, env, key, prompt, options, dependencies);
  }

  env[key] = value;
  await envState.setVar(key, value);
  return value;
}

async function readPersistedToken(tokenFile) {
  try {
    return (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function writeInstallerArtifacts(env) {
  const rendered = await renderInstallerArtifacts(env);

  await writeFile(`${env.ZROK_INSTANCE_DIR}/zrok-frontend-config.yml.envsubst`, rendered.frontendConfig);
  await writeFile(`${env.ZROK_INSTANCE_DIR}/.env`, rendered.zrokEnv);
  await writeFile(`${env.ZROK_INSTANCE_DIR}/compose.dokploy.yml`, rendered.dokployCompose);
}

function writeSummary(stdout, env, tokenFile) {
  log(stdout, 'Done');
  note(stdout, 'Dokploy panel bootstrap URL: http://127.0.0.1:3000');
  note(stdout, `Dokploy URL: ${env.DOKPLOY_URL}`);
  note(stdout, `zrok controller URL: https://${env.ZROK_DOMAIN}`);
  note(stdout, `Example share URL pattern: https://<share>.${env.ZROK_DOMAIN}`);
  if (env.ZROK_ACCOUNT_TOKEN) {
    note(stdout, `zrok account token file: ${tokenFile}`);
  }
  stdout.write('\nNext client-side commands:\n');
  stdout.write(`  zrok config set apiEndpoint https://${env.ZROK_DOMAIN}\n`);
  stdout.write('  zrok enable <ACCOUNT_TOKEN>\n');
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP_TEXT);
    return;
  }

  const args = parseInstallArgs(argv);
  const envState = await createEnvState(args.envFile);

  const getUid = dependencies.getUid ?? (() => process.getuid?.() ?? -1);
  const getPlatform = dependencies.getPlatform ?? (() => os.type());
  requireRootLinux({ uid: getUid(), platform: getPlatform() });

  const envMode = args.mode ?? envState.get('MODE') ?? 'pause';
  const deployMethod = args.deployMethod ?? envState.get('DEPLOY_METHOD') ?? 'raw';

  await setIfMissing(envState, 'INSTALL_DOKPLOY_CLI', DEFAULTS.INSTALL_DOKPLOY_CLI);
  await envState.setVar('DEPLOY_METHOD', deployMethod);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (key !== 'INSTALL_DOKPLOY_CLI') {
      await setIfMissing(envState, key, value);
    }
  }

  const env = envSnapshot(envState);
  env.DEPLOY_METHOD = deployMethod;

  if (!env.DOKPLOY_DOMAIN) {
    await ensurePromptedValue(envState, env, 'DOKPLOY_DOMAIN', 'Dokploy panel domain', {
      defaultValue: 'dokploy.example.com',
      secret: false,
      mode: envMode,
      envFile: args.envFile,
    }, {
      promptForValue: dependencies.promptForValue ?? defaultPromptForValue,
      stdout,
      stdin: dependencies.stdin ?? process.stdin,
    });
  }

  if (!env.ZROK_DOMAIN) {
    await ensurePromptedValue(envState, env, 'ZROK_DOMAIN', 'zrok base domain', {
      defaultValue: 'zrok.example.com',
      secret: false,
      mode: envMode,
      envFile: args.envFile,
    }, {
      promptForValue: dependencies.promptForValue ?? defaultPromptForValue,
      stdout,
      stdin: dependencies.stdin ?? process.stdin,
    });
  }

  if (!env.DOKPLOY_URL) {
    env.DOKPLOY_URL = `https://${env.DOKPLOY_DOMAIN}`;
    await envState.setVar('DOKPLOY_URL', env.DOKPLOY_URL);
  }

  const randomToken = dependencies.randomToken ?? createRandomToken;
  if (!env.ZROK_ADMIN_TOKEN) {
    env.ZROK_ADMIN_TOKEN = randomToken();
    await envState.setVar('ZROK_ADMIN_TOKEN', env.ZROK_ADMIN_TOKEN);
  }
  if (!env.ZITI_PWD) {
    env.ZITI_PWD = randomToken();
    await envState.setVar('ZITI_PWD', env.ZITI_PWD);
  }

  await (dependencies.ensureDokployInstalled ?? ((currentEnv) => defaultEnsureDokployInstalled(currentEnv, stdout)))(env);
  await (dependencies.waitForDokploy ?? (() => defaultWaitForDokploy(stdout)))();

  const publicIp = await (dependencies.getPublicIp ?? defaultGetPublicIp)();
  if (publicIp) {
    note(stdout, `Detected public IP: ${publicIp}`);
  }

  const pauseOrExit = dependencies.pauseOrExit ?? ((message) => defaultPauseOrExit({
    message,
    mode: envMode,
    stdin: dependencies.stdin ?? process.stdin,
    stdout,
  }));

  await pauseOrExit(`Manual checkpoint: open http://${publicIp || '127.0.0.1'}:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.`);

  const hostResolvesTo = dependencies.hostResolvesTo ?? defaultHostResolvesTo;
  if (publicIp && !(await hostResolvesTo(env.DOKPLOY_DOMAIN, publicIp))) {
    await pauseOrExit(`Manual checkpoint: point ${env.DOKPLOY_DOMAIN} to ${publicIp} and, if desired, configure that domain inside Dokploy before continuing.`);
  }

  const httpsOk = dependencies.httpsOk ?? defaultHttpsOk;
  if (!(await httpsOk(env.DOKPLOY_URL))) {
    await pauseOrExit(`Manual checkpoint: configure the Dokploy panel domain and HTTPS in the Dokploy UI, then confirm ${env.DOKPLOY_URL} loads successfully over HTTPS before continuing.`);
    if (!(await httpsOk(env.DOKPLOY_URL))) {
      throw new Error(`Dokploy HTTPS check failed for ${env.DOKPLOY_URL}. Fix panel HTTPS in the UI, then rerun.`);
    }
  }

  if (env.INSTALL_DOKPLOY_CLI === 'true') {
    await ensurePromptedValue(envState, env, 'DOKPLOY_API_TOKEN', 'Dokploy API token', {
      defaultValue: '',
      secret: true,
      mode: envMode,
      envFile: args.envFile,
    }, {
      promptForValue: dependencies.promptForValue ?? defaultPromptForValue,
      stdout,
      stdin: dependencies.stdin ?? process.stdin,
    });
    if (!(await (dependencies.checkCommandExists ?? checkCommandExists)('dokploy'))) {
      await (dependencies.installDokployCli ?? (() => defaultInstallDokployCli(stdout)))();
    }
    await (dependencies.authenticateDokployCli ?? ((url, token) => defaultAuthenticateDokployCli(stdout, url, token)))(env.DOKPLOY_URL, env.DOKPLOY_API_TOKEN);
  }

  await ensurePromptedValue(envState, env, 'ZROK_USER_EMAIL', 'First zrok user email', {
    defaultValue: 'admin@example.com',
    secret: false,
    mode: envMode,
    envFile: args.envFile,
  }, {
    promptForValue: dependencies.promptForValue ?? defaultPromptForValue,
    stdout,
    stdin: dependencies.stdin ?? process.stdin,
  });
  await ensurePromptedValue(envState, env, 'ZROK_USER_PWD', 'First zrok user password', {
    defaultValue: '',
    secret: true,
    mode: envMode,
    envFile: args.envFile,
  }, {
    promptForValue: dependencies.promptForValue ?? defaultPromptForValue,
    stdout,
    stdin: dependencies.stdin ?? process.stdin,
  });

  await mkdir(env.ZROK_INSTANCE_DIR, { recursive: true });
  await (dependencies.fetchZrokProject ?? ((targetDir) => defaultFetchZrokProject(stdout, targetDir)))(env.ZROK_INSTANCE_DIR);
  log(stdout, 'Writing minimal zrok frontend config template');
  log(stdout, 'Writing zrok project env file');
  log(stdout, 'Writing Dokploy Traefik override compose file');
  await writeInstallerArtifacts(env);

  if (publicIp && !(await hostResolvesTo(env.ZROK_DOMAIN, publicIp))) {
    await pauseOrExit(`Manual checkpoint: point ${env.ZROK_DOMAIN} to ${publicIp} and create a wildcard DNS record for *.${env.ZROK_DOMAIN} before continuing.`);
  }
  if (publicIp && !(await hostResolvesTo(`probe.${env.ZROK_DOMAIN}`, publicIp))) {
    await pauseOrExit(`Manual checkpoint: wildcard DNS for *.${env.ZROK_DOMAIN} does not resolve to ${publicIp} yet.`);
  }

  if (deployMethod === 'dokploy-compose-api') {
    await (dependencies.delegateComposeApi ?? ((helperArgs) => defaultDelegateComposeApi(stdout, helperArgs)))([
      '--env-file',
      args.envFile,
      '--mode',
      envMode,
      '--prepared',
    ]);
  } else {
    await (dependencies.deployRaw ?? ((targetDir) => defaultDeployRaw(stdout, targetDir)))(env.ZROK_INSTANCE_DIR);
  }

  const tokenFile = `${env.ZROK_INSTANCE_DIR}/.installer-state/zrok-account-token`;
  await mkdir(`${env.ZROK_INSTANCE_DIR}/.installer-state`, { recursive: true });
  await chmod(`${env.ZROK_INSTANCE_DIR}/.installer-state`, 0o700);

  let accountToken = env.ZROK_ACCOUNT_TOKEN || await readPersistedToken(tokenFile);
  if (accountToken) {
    await writeFile(tokenFile, `${accountToken}\n`);
    await chmod(tokenFile, 0o600);
    env.ZROK_ACCOUNT_TOKEN = accountToken;
    await envState.setVar('ZROK_ACCOUNT_TOKEN', accountToken);
    note(stdout, `Saved zrok account token to ${tokenFile}`);
  } else {
    await pauseOrExit(`Next manual checkpoint: the script is ready to create the first zrok account using ${env.ZROK_USER_EMAIL}. If you want to change the email or password, edit ${args.envFile} now.`);
    accountToken = await (dependencies.createZrokAccount ?? defaultCreateZrokAccount)({
      deployMethod,
      email: env.ZROK_USER_EMAIL,
      password: env.ZROK_USER_PWD,
      instanceDir: env.ZROK_INSTANCE_DIR,
      DOKPLOY_COMPOSE_APP_NAME: env.DOKPLOY_COMPOSE_APP_NAME,
      ZROK_USER_EMAIL: env.ZROK_USER_EMAIL,
      ZROK_USER_PWD: env.ZROK_USER_PWD,
      DEPLOY_METHOD: deployMethod,
      ZROK_INSTANCE_DIR: env.ZROK_INSTANCE_DIR,
    });
    await writeFile(tokenFile, `${accountToken}\n`);
    await chmod(tokenFile, 0o600);
    env.ZROK_ACCOUNT_TOKEN = accountToken;
    await envState.setVar('ZROK_ACCOUNT_TOKEN', accountToken);
    note(stdout, `Saved zrok account token to ${tokenFile}`);
  }

  writeSummary(stdout, env, tokenFile);
  stderr.write('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof GracefulExit) {
      process.exitCode = 0;
      return;
    }

    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
