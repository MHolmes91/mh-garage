#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  createDokployCompose,
  createDokployEnvironment,
  createDokployProject,
  createEnvState,
  deployDokployCompose,
  dokployGet,
  dokployPost,
  findComposeIdInEnvironment,
  findEnvironmentIdByName,
  findProjectIdByName,
  parseComposeApiArgs,
  renderComposeBundle,
  updateDokployCompose,
} from './lib.mjs';

const HELP_TEXT = `Usage: install-dokploy-compose-api.js [--env-file PATH] [--mode pause|exit] [--prepared]

This experimental helper installs zrok as a Dokploy-managed Docker Compose app
via Dokploy HTTP APIs. It is intended to be called by scripts/install.js after
shared Dokploy/zrok preparation is complete.
`;

const DEFAULTS = {
  DOKPLOY_PROJECT_NAME: 'zrok',
  DOKPLOY_PROJECT_DESCRIPTION: 'Self-hosted zrok services',
  DOKPLOY_ENVIRONMENT_NAME: 'production',
  DOKPLOY_ENVIRONMENT_DESCRIPTION: 'Production services',
  DOKPLOY_COMPOSE_NAME: 'zrok-instance',
  DOKPLOY_COMPOSE_DESCRIPTION: 'Self-hosted zrok on Dokploy',
  DOKPLOY_COMPOSE_APP_NAME: 'zrok-instance',
};

async function applyDefaults(envState) {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (!envState.get(key)) {
      await envState.setVar(key, value);
    }
  }
}

function snapshotEnv(envState) {
  return {
    DOKPLOY_URL: envState.get('DOKPLOY_URL'),
    DOKPLOY_API_TOKEN: envState.get('DOKPLOY_API_TOKEN'),
    DOKPLOY_PROJECT_NAME: envState.get('DOKPLOY_PROJECT_NAME'),
    DOKPLOY_PROJECT_DESCRIPTION: envState.get('DOKPLOY_PROJECT_DESCRIPTION'),
    DOKPLOY_PROJECT_ID: envState.get('DOKPLOY_PROJECT_ID'),
    DOKPLOY_ENVIRONMENT_NAME: envState.get('DOKPLOY_ENVIRONMENT_NAME'),
    DOKPLOY_ENVIRONMENT_DESCRIPTION: envState.get('DOKPLOY_ENVIRONMENT_DESCRIPTION'),
    DOKPLOY_ENVIRONMENT_ID: envState.get('DOKPLOY_ENVIRONMENT_ID'),
    DOKPLOY_COMPOSE_NAME: envState.get('DOKPLOY_COMPOSE_NAME'),
    DOKPLOY_COMPOSE_DESCRIPTION: envState.get('DOKPLOY_COMPOSE_DESCRIPTION'),
    DOKPLOY_COMPOSE_APP_NAME: envState.get('DOKPLOY_COMPOSE_APP_NAME'),
    DOKPLOY_COMPOSE_ID: envState.get('DOKPLOY_COMPOSE_ID'),
    ZROK_INSTANCE_DIR: envState.get('ZROK_INSTANCE_DIR'),
  };
}

async function persistVar(envState, env, key, value) {
  env[key] = value;
  await envState.setVar(key, value);
}

function requireValue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const {
    stdout = process.stdout,
    fetchFn = fetch,
    renderComposeBundle: renderBundle = renderComposeBundle,
  } = dependencies;

  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP_TEXT);
    return;
  }

  const args = parseComposeApiArgs(argv);
  const envState = await createEnvState(args.envFile);

  await applyDefaults(envState);

  if (!args.prepared) {
    throw new Error(
      'This helper expects prepared artifacts. Run scripts/install.js with --deploy-method dokploy-compose-api instead.',
    );
  }

  const env = snapshotEnv(envState);
  requireValue(env.DOKPLOY_URL, 'DOKPLOY_URL is required for the Dokploy Compose API installer.');
  requireValue(env.DOKPLOY_API_TOKEN, 'DOKPLOY_API_TOKEN is required for the Dokploy Compose API installer.');
  requireValue(env.ZROK_INSTANCE_DIR, 'ZROK_INSTANCE_DIR is required for the Dokploy Compose API installer.');

  const getJson = (endpoint, input) => dokployGet(env.DOKPLOY_URL, env.DOKPLOY_API_TOKEN, endpoint, input, fetchFn);
  const postJson = (endpoint, payload) => dokployPost(env.DOKPLOY_URL, env.DOKPLOY_API_TOKEN, endpoint, payload, fetchFn);

  if (!env.DOKPLOY_PROJECT_ID) {
    env.DOKPLOY_PROJECT_ID = findProjectIdByName(
      await getJson('project.all'),
      env.DOKPLOY_PROJECT_NAME,
    );
    if (!env.DOKPLOY_PROJECT_ID) {
      await persistVar(envState, env, 'DOKPLOY_PROJECT_ID', await createDokployProject(env, postJson));
    } else {
      await persistVar(envState, env, 'DOKPLOY_PROJECT_ID', env.DOKPLOY_PROJECT_ID);
    }
  }

  if (!env.DOKPLOY_ENVIRONMENT_ID) {
    const project = await getJson('project.one', { projectId: env.DOKPLOY_PROJECT_ID });
    env.DOKPLOY_ENVIRONMENT_ID = findEnvironmentIdByName(project, env.DOKPLOY_ENVIRONMENT_NAME);
    if (!env.DOKPLOY_ENVIRONMENT_ID) {
      await persistVar(
        envState,
        env,
        'DOKPLOY_ENVIRONMENT_ID',
        await createDokployEnvironment(env, postJson),
      );
    } else {
      await persistVar(envState, env, 'DOKPLOY_ENVIRONMENT_ID', env.DOKPLOY_ENVIRONMENT_ID);
    }
  }

  if (!env.DOKPLOY_COMPOSE_ID) {
    const project = await getJson('project.one', { projectId: env.DOKPLOY_PROJECT_ID });
    env.DOKPLOY_COMPOSE_ID = findComposeIdInEnvironment(
      project,
      env.DOKPLOY_ENVIRONMENT_NAME,
      env.DOKPLOY_COMPOSE_NAME,
      env.DOKPLOY_COMPOSE_APP_NAME,
    );
    if (!env.DOKPLOY_COMPOSE_ID) {
      await persistVar(envState, env, 'DOKPLOY_COMPOSE_ID', await createDokployCompose(env, postJson));
    } else {
      await persistVar(envState, env, 'DOKPLOY_COMPOSE_ID', env.DOKPLOY_COMPOSE_ID);
    }
  }

  const bundle = await renderBundle(env.ZROK_INSTANCE_DIR);
  await updateDokployCompose(env, bundle, postJson);
  await deployDokployCompose(env, postJson);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
