import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { extractLastNonEmptyLine, runCommand, runCommandCapture } from '../command-runner.mjs';
import { log, note } from './install-logging.mjs';

export async function ensureDokployInstalled(env, stdout) {
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

export async function installDokployCli(stdout) {
  log(stdout, 'Installing Dokploy CLI');
  await runCommand('npm', ['install', '-g', '@dokploy/cli']);
}

export async function authenticateDokployCli(stdout, url, token) {
  log(stdout, 'Authenticating Dokploy CLI');
  await runCommand('dokploy', ['authenticate', '-u', url, '-t', token]);
}

export async function fetchZrokProject(stdout, instanceDir) {
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

export async function deployRawStack(stdout, instanceDir) {
  log(stdout, 'Deploying the zrok stack');
  await runCommand('docker', ['network', 'inspect', 'dokploy-network']);
  await runCommand('docker', ['compose', '-f', 'compose.yml', '-f', 'compose.dokploy.yml', 'up', '-d', '--build'], undefined, {
    stdio: 'inherit',
    cwd: instanceDir,
  });
}

export async function delegateComposeApiInstall(stdout, args) {
  log(stdout, 'Delegating zrok deployment to Dokploy Compose API helper');
  const helperPath = fileURLToPath(new URL('../../install-dokploy-compose-api.js', import.meta.url));
  await runCommand(process.execPath, [helperPath, ...args]);
}

export async function createZrokAccount(env) {
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
