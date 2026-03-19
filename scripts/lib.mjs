import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const MODE_VALUES = ['pause', 'exit'];
const DEPLOY_METHOD_VALUES = ['raw', 'dokploy-compose-api'];

function parseEnvValue(value) {
  if (value.startsWith("'")) {
    return value.slice(1, -1).replaceAll(`'"'"'`, "'");
  }

  return value;
}

function requireEnumValue(label, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(
      `Invalid ${label}: ${value}. Allowed values: ${allowedValues.join(', ')}`,
    );
  }

  return value;
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];

  if (value == null || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }

  return value;
}

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

export function validateMode(mode) {
  return requireEnumValue('mode', mode, MODE_VALUES);
}

export function validateDeployMethod(method) {
  return requireEnumValue('deploy method', method, DEPLOY_METHOD_VALUES);
}

export function validateComposeApiMode(mode) {
  return requireEnumValue('compose api mode', mode, MODE_VALUES);
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

export function parseInstallArgs(argv) {
  const args = {
    envFile: '.env',
    mode: undefined,
    deployMethod: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--env-file') {
      args.envFile = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      args.mode = requireEnumValue('mode', requireOptionValue(argv, index, arg), MODE_VALUES);
      index += 1;
      continue;
    }

    if (arg === '--deploy-method') {
      args.deployMethod = requireEnumValue(
        'deploy method',
        requireOptionValue(argv, index, arg),
        DEPLOY_METHOD_VALUES,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

export function parseComposeApiArgs(argv) {
  const args = {
    envFile: '.env',
    mode: 'pause',
    prepared: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--env-file') {
      args.envFile = requireOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === '--mode') {
      args.mode = requireEnumValue('mode', requireOptionValue(argv, index, arg), MODE_VALUES);
      index += 1;
      continue;
    }

    if (arg === '--prepared') {
      args.prepared = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
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

function normalizeDokployUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

async function parseDokployResponse(response) {
  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(body || `Dokploy request failed with status ${response.status}`);
  }

  const payload = await response.json();
  return payload?.result?.data?.json;
}

export async function dokployGet(baseUrl, apiToken, endpoint, input, fetchFn = fetch) {
  const url = new URL(`${normalizeDokployUrl(baseUrl)}/api/trpc/${endpoint}`);

  if (input != null) {
    url.searchParams.set('input', JSON.stringify({ json: input }));
  }

  return parseDokployResponse(await fetchFn(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiToken,
    },
  }));
}

export async function dokployPost(baseUrl, apiToken, endpoint, payload, fetchFn = fetch) {
  return parseDokployResponse(await fetchFn(`${normalizeDokployUrl(baseUrl)}/api/trpc/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiToken,
    },
    body: JSON.stringify({ json: payload }),
  }));
}

export function findProjectIdByName(projects, name) {
  return projects.find((project) => project.name === name)?.projectId ?? '';
}

export function findEnvironmentIdByName(project, name) {
  return project.environments?.find((environment) => environment.name === name)?.environmentId ?? '';
}

export function findComposeIdInEnvironment(project, environmentName, composeName, composeAppName) {
  const environment = project.environments?.find((entry) => entry.name === environmentName);
  return environment?.compose?.find(
    (compose) => compose.name === composeName || compose.appName === composeAppName,
  )?.composeId ?? '';
}

export async function createDokployProject(env, postJson) {
  const result = await postJson('project.create', {
    name: env.DOKPLOY_PROJECT_NAME,
    description: env.DOKPLOY_PROJECT_DESCRIPTION,
  });
  return result.projectId;
}

export async function createDokployEnvironment(env, postJson) {
  const result = await postJson('environment.create', {
    name: env.DOKPLOY_ENVIRONMENT_NAME,
    description: env.DOKPLOY_ENVIRONMENT_DESCRIPTION,
    projectId: env.DOKPLOY_PROJECT_ID,
  });
  return result.environmentId;
}

export async function createDokployCompose(env, postJson) {
  const result = await postJson('compose.create', {
    name: env.DOKPLOY_COMPOSE_NAME,
    description: env.DOKPLOY_COMPOSE_DESCRIPTION,
    environmentId: env.DOKPLOY_ENVIRONMENT_ID,
    composeType: 'docker-compose',
    appName: env.DOKPLOY_COMPOSE_APP_NAME,
  });
  return result.composeId;
}

export async function updateDokployCompose(env, bundle, postJson) {
  await postJson('compose.update', {
    composeId: env.DOKPLOY_COMPOSE_ID,
    sourceType: 'raw',
    composePath: './docker-compose.yml',
    composeFile: bundle.composeYaml,
    env: bundle.composeEnv,
    name: env.DOKPLOY_COMPOSE_NAME,
    description: env.DOKPLOY_COMPOSE_DESCRIPTION,
  });
}

export async function deployDokployCompose(env, postJson) {
  await postJson('compose.deploy', {
    composeId: env.DOKPLOY_COMPOSE_ID,
    title: 'Install self-hosted zrok',
    description: 'Automated zrok compose deployment',
  });
}

export async function renderComposeBundle(
  instanceDir,
  captureFn = runCommandCapture,
  readFileFn = readFile,
) {
  const { stdout } = await captureFn(
    'docker',
    ['compose', '-f', 'compose.yml', '-f', 'compose.dokploy.yml', 'config'],
    undefined,
    { cwd: instanceDir },
  );

  return {
    composeYaml: stdout,
    composeEnv: await readFileFn(`${instanceDir}/.env`, 'utf8'),
  };
}

export function requireRootLinux({ uid, platform }) {
  if (uid !== 0) {
    throw new Error('This script must run as root.');
  }

  if (platform !== 'Linux') {
    throw new Error('This script only supports Linux hosts.');
  }
}

export function renderTemplate(templateText, variables) {
  return String(templateText).replaceAll(/\$\{([A-Z0-9_]+)\}/g, (match, name) => {
    if (!(name in variables) || variables[name] === '') {
      throw new Error(`Missing template variable: ${name}`);
    }

    return String(variables[name]);
  });
}

const INSTALLER_TEMPLATE_PATHS = {
  frontendConfigTemplate: new URL('./templates/zrok-frontend-config.yml.envsubst', import.meta.url),
  zrokEnvTemplate: new URL('./templates/zrok.env', import.meta.url),
  dokployComposeTemplate: new URL('./templates/compose.dokploy.yml', import.meta.url),
};

export async function loadInstallerTemplates(readFileFn = readFile) {
  const [frontendConfigTemplate, zrokEnvTemplate, dokployComposeTemplate] = await Promise.all([
    readFileFn(INSTALLER_TEMPLATE_PATHS.frontendConfigTemplate, 'utf8'),
    readFileFn(INSTALLER_TEMPLATE_PATHS.zrokEnvTemplate, 'utf8'),
    readFileFn(INSTALLER_TEMPLATE_PATHS.dokployComposeTemplate, 'utf8'),
  ]);

  return {
    frontendConfigTemplate,
    zrokEnvTemplate,
    dokployComposeTemplate,
  };
}

export function createInstallerTemplateVariables(env) {
  return Object.fromEntries(Object.entries({
    ZROK_DNS_ZONE: '${ZROK_DNS_ZONE}',
    ZROK_FRONTEND_PORT: '${ZROK_FRONTEND_PORT}',
    ZROK_DOMAIN: env.ZROK_DOMAIN,
    ZROK_USER_EMAIL: env.ZROK_USER_EMAIL,
    ZROK_USER_PWD: env.ZROK_USER_PWD,
    ZROK_ADMIN_TOKEN: env.ZROK_ADMIN_TOKEN,
    ZITI_PWD: env.ZITI_PWD,
    ZROK_CTRL_PORT: env.ZROK_CTRL_PORT,
    ZROK_FRONTEND_INTERNAL_PORT: env.ZROK_FRONTEND_INTERNAL_PORT,
    ZROK_OAUTH_PORT: env.ZROK_OAUTH_PORT,
    ZITI_CTRL_ADVERTISED_PORT: env.ZITI_CTRL_ADVERTISED_PORT,
    ZITI_ROUTER_PORT: env.ZITI_ROUTER_PORT,
    TRAEFIK_CERT_RESOLVER: env.TRAEFIK_CERT_RESOLVER,
    ZROK_PUBLIC_HTTPS_PORT: env.ZROK_PUBLIC_HTTPS_PORT,
  }).filter(([, value]) => value !== undefined));
}

function renderNamedTemplate(templatePath, templateText, variables) {
  try {
    return renderTemplate(templateText, variables);
  } catch (error) {
    throw new Error(`${basename(templatePath.pathname)}: ${error.message}`);
  }
}

export async function renderInstallerArtifacts(env, readFileFn = readFile) {
  const templates = await loadInstallerTemplates(readFileFn);
  const variables = createInstallerTemplateVariables(env);

  return {
    frontendConfig: renderNamedTemplate(
      INSTALLER_TEMPLATE_PATHS.frontendConfigTemplate,
      templates.frontendConfigTemplate,
      variables,
    ),
    zrokEnv: renderNamedTemplate(INSTALLER_TEMPLATE_PATHS.zrokEnvTemplate, templates.zrokEnvTemplate, variables),
    dokployCompose: renderNamedTemplate(
      INSTALLER_TEMPLATE_PATHS.dokployComposeTemplate,
      templates.dokployComposeTemplate,
      variables,
    ),
  };
}

export function extractLastNonEmptyLine(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
}
