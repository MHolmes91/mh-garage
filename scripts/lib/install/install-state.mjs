import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

import { renderInstallerArtifacts } from '../template-renderer.mjs';
import { ENV_SNAPSHOT_KEYS } from './install-constants.mjs';
import { GracefulExit, note } from './install-logging.mjs';

export function envSnapshot(envState) {
  return Object.fromEntries(ENV_SNAPSHOT_KEYS.map((key) => [key, envState.get(key) ?? '']));
}

export async function setIfMissing(envState, key, value) {
  if (!envState.get(key)) {
    await envState.setVar(key, value);
  }
}

export function createRandomToken() {
  return randomBytes(64).toString('base64').replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 40);
}

export async function ensurePromptedValue(envState, env, key, prompt, options, dependencies) {
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

export async function readSavedToken(tokenFile) {
  try {
    return (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    return '';
  }
}

export async function writeRenderedArtifacts(env) {
  const rendered = await renderInstallerArtifacts(env);

  await writeFile(`${env.ZROK_INSTANCE_DIR}/zrok-frontend-config.yml.envsubst`, rendered.frontendConfig);
  await writeFile(`${env.ZROK_INSTANCE_DIR}/.env`, rendered.zrokEnv);
  await writeFile(`${env.ZROK_INSTANCE_DIR}/compose.dokploy.yml`, rendered.dokployCompose);
}

export async function persistAccountToken(envState, env, tokenFile, accountToken, stdout) {
  await writeFile(tokenFile, `${accountToken}\n`);
  await chmod(tokenFile, 0o600);
  env.ZROK_ACCOUNT_TOKEN = accountToken;
  await envState.setVar('ZROK_ACCOUNT_TOKEN', accountToken);
  note(stdout, `Saved zrok account token to ${tokenFile}`);
}

export async function ensureInstallerStateDir(instanceDir) {
  const stateDir = `${instanceDir}/.installer-state`;
  await mkdir(stateDir, { recursive: true });
  await chmod(stateDir, 0o700);
  return stateDir;
}
