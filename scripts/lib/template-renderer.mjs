import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { runCommandCapture } from './command-runner.mjs';

const INSTALLER_TEMPLATE_PATHS = {
  frontendConfigTemplate: new URL('../templates/zrok-frontend-config.yml.envsubst', import.meta.url),
  zrokEnvTemplate: new URL('../templates/zrok.env', import.meta.url),
  dokployComposeTemplate: new URL('../templates/compose.dokploy.yml', import.meta.url),
};

function renderNamedTemplate(templatePath, templateText, variables) {
  try {
    return renderTemplate(templateText, variables);
  } catch (error) {
    throw new Error(`${basename(templatePath.pathname)}: ${error.message}`);
  }
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
