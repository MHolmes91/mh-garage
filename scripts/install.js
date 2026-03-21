#!/usr/bin/env node

import os from 'node:os';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  checkCommandExists,
  createEnvState,
  parseInstallArgs,
  requireRootLinux,
} from './lib/index.mjs';
import { HELP_TEXT, DEFAULTS } from './lib/install/install-constants.mjs';
import {
  GracefulExit,
  pauseOrExitAtCheckpoint,
  promptForValueInteractive,
  log,
  note,
  writeInstallSummary,
} from './lib/install/install-logging.mjs';
import {
  authenticateDokployCli,
  createZrokAccount,
  delegateComposeApiInstall,
  deployRawStack,
  ensureDokployInstalled,
  fetchZrokProject,
  installDokployCli,
} from './lib/install/install-deployment.mjs';
import {
  detectPublicIp,
  hostResolvesToAddress,
  isHttpsReachable,
  waitForDokployPanel,
} from './lib/install/install-network.mjs';
import {
  createRandomToken,
  ensureInstallerStateDir,
  ensurePromptedValue,
  envSnapshot,
  persistAccountToken,
  readSavedToken,
  setIfMissing,
  writeRenderedArtifacts,
} from './lib/install/install-state.mjs';

function resolvePromptDependencies(dependencies, stdout) {
  return {
    promptForValue: dependencies.promptForValue ?? promptForValueInteractive,
    stdout,
    stdin: dependencies.stdin ?? process.stdin,
  };
}

async function ensureConfigValue(envState, env, key, prompt, options, dependencies, stdout) {
  return ensurePromptedValue(
    envState,
    env,
    key,
    prompt,
    options,
    resolvePromptDependencies(dependencies, stdout),
  );
}

function resolveCheckpointHandler(envMode, dependencies, stdout) {
  return dependencies.pauseOrExit ?? ((message) => pauseOrExitAtCheckpoint({
    message,
    mode: envMode,
    stdin: dependencies.stdin ?? process.stdin,
    stdout,
  }));
}

async function initializeInstallContext(envState, args, dependencies) {
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

  return { env, envMode, deployMethod };
}

async function ensureCoreConfig(envState, env, envMode, args, dependencies, stdout) {
  if (!env.DOKPLOY_DOMAIN) {
    await ensureConfigValue(envState, env, 'DOKPLOY_DOMAIN', 'Dokploy panel domain', {
      defaultValue: 'dokploy.example.com',
      secret: false,
      mode: envMode,
      envFile: args.envFile,
    }, dependencies, stdout);
  }

  if (!env.ZROK_DOMAIN) {
    await ensureConfigValue(envState, env, 'ZROK_DOMAIN', 'zrok base domain', {
      defaultValue: 'zrok.example.com',
      secret: false,
      mode: envMode,
      envFile: args.envFile,
    }, dependencies, stdout);
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
}

async function ensureDokployCliAccess(envState, env, envMode, args, dependencies, stdout) {
  if (env.INSTALL_DOKPLOY_CLI !== 'true') {
    return;
  }

  await ensureConfigValue(envState, env, 'DOKPLOY_API_TOKEN', 'Dokploy API token', {
    defaultValue: '',
    secret: true,
    mode: envMode,
    envFile: args.envFile,
  }, dependencies, stdout);

  if (!(await (dependencies.checkCommandExists ?? checkCommandExists)('dokploy'))) {
    await (dependencies.installDokployCli ?? (() => installDokployCli(stdout)))();
  }

  await (dependencies.authenticateDokployCli ?? ((url, token) => authenticateDokployCli(stdout, url, token)))(
    env.DOKPLOY_URL,
    env.DOKPLOY_API_TOKEN,
  );
}

async function ensureZrokUserConfig(envState, env, envMode, args, dependencies, stdout) {
  await ensureConfigValue(envState, env, 'ZROK_USER_EMAIL', 'First zrok user email', {
    defaultValue: 'admin@example.com',
    secret: false,
    mode: envMode,
    envFile: args.envFile,
  }, dependencies, stdout);

  await ensureConfigValue(envState, env, 'ZROK_USER_PWD', 'First zrok user password', {
    defaultValue: '',
    secret: true,
    mode: envMode,
    envFile: args.envFile,
  }, dependencies, stdout);
}

async function prepareZrokProject(env, dependencies, stdout) {
  await mkdir(env.ZROK_INSTANCE_DIR, { recursive: true });
  await (dependencies.fetchZrokProject ?? ((targetDir) => fetchZrokProject(stdout, targetDir)))(env.ZROK_INSTANCE_DIR);
  log(stdout, 'Writing minimal zrok frontend config template');
  log(stdout, 'Writing zrok project env file');
  log(stdout, 'Writing Dokploy Traefik override compose file');
  await writeRenderedArtifacts(env);
}

async function runInstallDeployment(env, deployMethod, args, envMode, dependencies, stdout) {
  if (deployMethod === 'dokploy-compose-api') {
    await (dependencies.delegateComposeApi ?? ((helperArgs) => delegateComposeApiInstall(stdout, helperArgs)))([
      '--env-file',
      args.envFile,
      '--mode',
      envMode,
      '--prepared',
    ]);
    return;
  }

  await (dependencies.deployRaw ?? ((targetDir) => deployRawStack(stdout, targetDir)))(env.ZROK_INSTANCE_DIR);
}

async function finalizeAccountToken(envState, env, args, deployMethod, pauseOrExit, dependencies, stdout) {
  const stateDir = await ensureInstallerStateDir(env.ZROK_INSTANCE_DIR);
  const tokenFile = `${stateDir}/zrok-account-token`;

  let accountToken = env.ZROK_ACCOUNT_TOKEN || await readSavedToken(tokenFile);
  if (!accountToken) {
    await pauseOrExit(`Next manual checkpoint: the script is ready to create the first zrok account using ${env.ZROK_USER_EMAIL}. If you want to change the email or password, edit ${args.envFile} now.`);
    accountToken = await (dependencies.createZrokAccount ?? createZrokAccount)({
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
  }

  await persistAccountToken(envState, env, tokenFile, accountToken, stdout);
  return tokenFile;
}

/**
 * Runs the interactive installer for a self-hosted zrok deployment.
 * @param {string[]} [argv]
 * @param {Record<string, any>} [dependencies]
 * @returns {Promise<void>}
 */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP_TEXT);
    return;
  }

  const args = parseInstallArgs(argv);
  const envState = await createEnvState(args.envFile);
  const { env, envMode, deployMethod } = await initializeInstallContext(envState, args, dependencies);

  await ensureCoreConfig(envState, env, envMode, args, dependencies, stdout);

  await (dependencies.ensureDokployInstalled ?? ((currentEnv) => ensureDokployInstalled(currentEnv, stdout)))(env);
  await (dependencies.waitForDokploy ?? (() => waitForDokployPanel(stdout)))();

  const publicIp = await (dependencies.getPublicIp ?? detectPublicIp)();
  if (publicIp) {
    note(stdout, `Detected public IP: ${publicIp}`);
  }

  const pauseOrExit = resolveCheckpointHandler(envMode, dependencies, stdout);
  await pauseOrExit(`Manual checkpoint: open http://${publicIp || '127.0.0.1'}:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.`);

  const hostResolvesTo = dependencies.hostResolvesTo ?? hostResolvesToAddress;
  if (publicIp && !(await hostResolvesTo(env.DOKPLOY_DOMAIN, publicIp))) {
    await pauseOrExit(`Manual checkpoint: point ${env.DOKPLOY_DOMAIN} to ${publicIp} and, if desired, configure that domain inside Dokploy before continuing.`);
  }

  const httpsOk = dependencies.httpsOk ?? isHttpsReachable;
  if (!(await httpsOk(env.DOKPLOY_URL))) {
    await pauseOrExit(`Manual checkpoint: configure the Dokploy panel domain and HTTPS in the Dokploy UI, then confirm ${env.DOKPLOY_URL} loads successfully over HTTPS before continuing.`);
    if (!(await httpsOk(env.DOKPLOY_URL))) {
      throw new Error(`Dokploy HTTPS check failed for ${env.DOKPLOY_URL}. Fix panel HTTPS in the UI, then rerun.`);
    }
  }

  await ensureDokployCliAccess(envState, env, envMode, args, dependencies, stdout);
  await ensureZrokUserConfig(envState, env, envMode, args, dependencies, stdout);
  await prepareZrokProject(env, dependencies, stdout);

  if (publicIp && !(await hostResolvesTo(env.ZROK_DOMAIN, publicIp))) {
    await pauseOrExit(`Manual checkpoint: point ${env.ZROK_DOMAIN} to ${publicIp} and create a wildcard DNS record for *.${env.ZROK_DOMAIN} before continuing.`);
  }
  if (publicIp && !(await hostResolvesTo(`probe.${env.ZROK_DOMAIN}`, publicIp))) {
    await pauseOrExit(`Manual checkpoint: wildcard DNS for *.${env.ZROK_DOMAIN} does not resolve to ${publicIp} yet.`);
  }

  await runInstallDeployment(env, deployMethod, args, envMode, dependencies, stdout);
  const tokenFile = await finalizeAccountToken(envState, env, args, deployMethod, pauseOrExit, dependencies, stdout);

  writeInstallSummary(stdout, env, tokenFile);
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
