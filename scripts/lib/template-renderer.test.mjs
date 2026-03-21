import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('renderComposeBundle shells out to docker compose config and reads .env', async () => {
  const { renderComposeBundle } = await import('./index.mjs');
  const tempDir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const commandLog = [];

  await writeFile(join(tempDir, '.env'), 'NAME=value\n');

  const bundle = await renderComposeBundle(tempDir, async (command, args, spawnFn, options) => {
    commandLog.push({ command, args, spawnFn, options });
    return { stdout: 'services:\n  zrok:\n    image: example\n' };
  });

  assert.deepEqual(bundle, { composeYaml: 'services:\n  zrok:\n    image: example\n', composeEnv: 'NAME=value\n' });
  assert.deepEqual(commandLog, [{ command: 'docker', args: ['compose', '-f', 'compose.yml', '-f', 'compose.dokploy.yml', 'config'], spawnFn: undefined, options: { cwd: tempDir } }]);
});

test('renderTemplate substitutes placeholder variables', async () => {
  const { renderTemplate } = await import('./index.mjs');
  assert.equal(renderTemplate('Hello ${NAME}, welcome to ${PLACE}!', { NAME: 'Mark', PLACE: 'mh-garage' }), 'Hello Mark, welcome to mh-garage!');
});

test('renderTemplate throws a readable error when a variable is missing', async () => {
  const { renderTemplate } = await import('./index.mjs');
  assert.throws(() => renderTemplate('Hello ${NAME}', {}), /Missing template variable: NAME/);
});

test('checked-in installer templates exist and keep envsubst placeholders', async () => {
  const frontendTemplatePath = fileURLToPath(new URL('../templates/zrok-frontend-config.yml.envsubst', import.meta.url));
  const zrokEnvTemplatePath = fileURLToPath(new URL('../templates/zrok.env', import.meta.url));
  const dokployComposeTemplatePath = fileURLToPath(new URL('../templates/compose.dokploy.yml', import.meta.url));
  const [frontendTemplate, zrokEnvTemplate, dokployComposeTemplate] = await Promise.all([
    readFile(frontendTemplatePath, 'utf8'),
    readFile(zrokEnvTemplatePath, 'utf8'),
    readFile(dokployComposeTemplatePath, 'utf8'),
  ]);

  assert.equal(frontendTemplate, 'v: 4\n\nhost_match: ${ZROK_DNS_ZONE}\naddress: 0.0.0.0:${ZROK_FRONTEND_PORT}\n');
  assert.equal(zrokEnvTemplate, ['ZROK_DNS_ZONE=${ZROK_DOMAIN}', 'ZROK_USER_EMAIL=${ZROK_USER_EMAIL}', 'ZROK_USER_PWD=${ZROK_USER_PWD}', 'ZROK_ADMIN_TOKEN=${ZROK_ADMIN_TOKEN}', 'ZITI_PWD=${ZITI_PWD}', 'ZROK_CTRL_PORT=${ZROK_CTRL_PORT}', 'ZROK_FRONTEND_PORT=${ZROK_FRONTEND_INTERNAL_PORT}', 'ZROK_OAUTH_PORT=${ZROK_OAUTH_PORT}', 'ZITI_CTRL_ADVERTISED_PORT=${ZITI_CTRL_ADVERTISED_PORT}', 'ZITI_ROUTER_PORT=${ZITI_ROUTER_PORT}', 'ZROK_INSECURE_INTERFACE=127.0.0.1', 'ZITI_INTERFACE=0.0.0.0', ''].join('\n'));
  assert.equal(dokployComposeTemplate, ['services:', '  zrok-controller:', '    networks:', '      - zrok-instance', '      - dokploy-network', '    labels:', '      - traefik.enable=true', "      - 'traefik.http.routers.zrok-controller-web.rule=Host(\"${ZROK_DOMAIN}\")'", '      - traefik.http.routers.zrok-controller-web.entrypoints=web', '      - traefik.http.routers.zrok-controller-web.middlewares=redirect-to-https@file', '      - traefik.http.routers.zrok-controller-web.service=zrok-controller', "      - 'traefik.http.routers.zrok-controller-websecure.rule=Host(\"${ZROK_DOMAIN}\")'", '      - traefik.http.routers.zrok-controller-websecure.entrypoints=websecure', '      - traefik.http.routers.zrok-controller-websecure.tls=true', '      - traefik.http.routers.zrok-controller-websecure.tls.certresolver=${TRAEFIK_CERT_RESOLVER}', '      - traefik.http.routers.zrok-controller-websecure.service=zrok-controller', '      - traefik.http.services.zrok-controller.loadbalancer.server.port=${ZROK_CTRL_PORT}', '', '  zrok-frontend:', '    networks:', '      - zrok-instance', '      - dokploy-network', '    environment:', '      ZROK_FRONTEND_SCHEME: https', '      ZROK_FRONTEND_PORT: "${ZROK_PUBLIC_HTTPS_PORT}"', '    labels:', '      - traefik.enable=true', "      - 'traefik.http.routers.zrok-frontend-web.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.${ZROK_DOMAIN}\")'", '      - traefik.http.routers.zrok-frontend-web.entrypoints=web', '      - traefik.http.routers.zrok-frontend-web.middlewares=redirect-to-https@file', '      - traefik.http.routers.zrok-frontend-web.service=zrok-frontend', "      - 'traefik.http.routers.zrok-frontend-websecure.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.${ZROK_DOMAIN}\")'", '      - traefik.http.routers.zrok-frontend-websecure.entrypoints=websecure', '      - traefik.http.routers.zrok-frontend-websecure.tls=true', '      - traefik.http.routers.zrok-frontend-websecure.tls.certresolver=${TRAEFIK_CERT_RESOLVER}', '      - traefik.http.routers.zrok-frontend-websecure.service=zrok-frontend', '      - traefik.http.services.zrok-frontend.loadbalancer.server.port=${ZROK_FRONTEND_INTERNAL_PORT}', '', 'networks:', '  dokploy-network:', '    external: true', ''].join('\n'));
});

test('renderInstallerArtifacts renders template-backed installer files with expected values', async () => {
  const { renderInstallerArtifacts } = await import('./index.mjs');
  const renderedArtifacts = await renderInstallerArtifacts({
    ZROK_DOMAIN: 'zrok.example.com',
    ZROK_USER_EMAIL: 'admin@example.com',
    ZROK_USER_PWD: 'hunter2',
    ZROK_ADMIN_TOKEN: 'admin-token-123',
    ZITI_PWD: 'ziti-password-456',
    ZROK_CTRL_PORT: '18080',
    ZROK_FRONTEND_INTERNAL_PORT: '8080',
    ZROK_OAUTH_PORT: '8081',
    ZITI_CTRL_ADVERTISED_PORT: '1443',
    ZITI_ROUTER_PORT: '3022',
    TRAEFIK_CERT_RESOLVER: 'letsencrypt',
    ZROK_PUBLIC_HTTPS_PORT: '443',
  });

  assert.deepEqual(renderedArtifacts, {
    frontendConfig: 'v: 4\n\nhost_match: ${ZROK_DNS_ZONE}\naddress: 0.0.0.0:${ZROK_FRONTEND_PORT}\n',
    zrokEnv: ['ZROK_DNS_ZONE=zrok.example.com', 'ZROK_USER_EMAIL=admin@example.com', 'ZROK_USER_PWD=hunter2', 'ZROK_ADMIN_TOKEN=admin-token-123', 'ZITI_PWD=ziti-password-456', 'ZROK_CTRL_PORT=18080', 'ZROK_FRONTEND_PORT=8080', 'ZROK_OAUTH_PORT=8081', 'ZITI_CTRL_ADVERTISED_PORT=1443', 'ZITI_ROUTER_PORT=3022', 'ZROK_INSECURE_INTERFACE=127.0.0.1', 'ZITI_INTERFACE=0.0.0.0', ''].join('\n'),
    dokployCompose: ['services:', '  zrok-controller:', '    networks:', '      - zrok-instance', '      - dokploy-network', '    labels:', '      - traefik.enable=true', "      - 'traefik.http.routers.zrok-controller-web.rule=Host(\"zrok.example.com\")'", '      - traefik.http.routers.zrok-controller-web.entrypoints=web', '      - traefik.http.routers.zrok-controller-web.middlewares=redirect-to-https@file', '      - traefik.http.routers.zrok-controller-web.service=zrok-controller', "      - 'traefik.http.routers.zrok-controller-websecure.rule=Host(\"zrok.example.com\")'", '      - traefik.http.routers.zrok-controller-websecure.entrypoints=websecure', '      - traefik.http.routers.zrok-controller-websecure.tls=true', '      - traefik.http.routers.zrok-controller-websecure.tls.certresolver=letsencrypt', '      - traefik.http.routers.zrok-controller-websecure.service=zrok-controller', '      - traefik.http.services.zrok-controller.loadbalancer.server.port=18080', '', '  zrok-frontend:', '    networks:', '      - zrok-instance', '      - dokploy-network', '    environment:', '      ZROK_FRONTEND_SCHEME: https', '      ZROK_FRONTEND_PORT: "443"', '    labels:', '      - traefik.enable=true', "      - 'traefik.http.routers.zrok-frontend-web.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.zrok.example.com\")'", '      - traefik.http.routers.zrok-frontend-web.entrypoints=web', '      - traefik.http.routers.zrok-frontend-web.middlewares=redirect-to-https@file', '      - traefik.http.routers.zrok-frontend-web.service=zrok-frontend', "      - 'traefik.http.routers.zrok-frontend-websecure.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.zrok.example.com\")'", '      - traefik.http.routers.zrok-frontend-websecure.entrypoints=websecure', '      - traefik.http.routers.zrok-frontend-websecure.tls=true', '      - traefik.http.routers.zrok-frontend-websecure.tls.certresolver=letsencrypt', '      - traefik.http.routers.zrok-frontend-websecure.service=zrok-frontend', '      - traefik.http.services.zrok-frontend.loadbalancer.server.port=8080', '', 'networks:', '  dokploy-network:', '    external: true', ''].join('\n'),
  });
});

test('renderInstallerArtifacts fails fast with a readable template file error for missing variables', async () => {
  const { renderInstallerArtifacts } = await import('./index.mjs');
  await assert.rejects(renderInstallerArtifacts({ ZROK_DOMAIN: 'zrok.example.com', ZROK_USER_EMAIL: 'admin@example.com', ZROK_USER_PWD: 'hunter2', ZROK_ADMIN_TOKEN: 'admin-token-123', ZITI_PWD: 'ziti-password-456', ZROK_CTRL_PORT: '18080', ZROK_FRONTEND_INTERNAL_PORT: '8080', ZROK_OAUTH_PORT: '8081', ZITI_CTRL_ADVERTISED_PORT: '1443', ZITI_ROUTER_PORT: '3022', TRAEFIK_CERT_RESOLVER: 'letsencrypt' }), /compose\.dokploy\.yml: Missing template variable: ZROK_PUBLIC_HTTPS_PORT/);
});

test('renderInstallerArtifacts treats empty-string required values as missing with a readable template file error', async () => {
  const { renderInstallerArtifacts } = await import('./index.mjs');
  await assert.rejects(renderInstallerArtifacts({ ZROK_DOMAIN: 'zrok.example.com', ZROK_USER_EMAIL: 'admin@example.com', ZROK_USER_PWD: 'hunter2', ZROK_ADMIN_TOKEN: 'admin-token-123', ZITI_PWD: 'ziti-password-456', ZROK_CTRL_PORT: '18080', ZROK_FRONTEND_INTERNAL_PORT: '8080', ZROK_OAUTH_PORT: '8081', ZITI_CTRL_ADVERTISED_PORT: '1443', ZITI_ROUTER_PORT: '3022', TRAEFIK_CERT_RESOLVER: 'letsencrypt', ZROK_PUBLIC_HTTPS_PORT: '' }), /compose\.dokploy\.yml: Missing template variable: ZROK_PUBLIC_HTTPS_PORT/);
});
