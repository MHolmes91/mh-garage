import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('parseInstallArgs reads env file, mode, and deploy method', async () => {
  const { parseInstallArgs } = await import('./lib.mjs');

  assert.deepEqual(
    parseInstallArgs([
      '--env-file',
      'custom.env',
      '--mode',
      'exit',
      '--deploy-method',
      'dokploy-compose-api',
    ]),
    {
      envFile: 'custom.env',
      mode: 'exit',
      deployMethod: 'dokploy-compose-api',
    },
  );
});

test('parseInstallArgs leaves mode and deploy method unset when omitted', async () => {
  const { parseInstallArgs } = await import('./lib.mjs');

  assert.deepEqual(parseInstallArgs(['--env-file', 'custom.env']), {
    envFile: 'custom.env',
    mode: undefined,
    deployMethod: undefined,
  });
});

test('parseInstallArgs rejects unsupported enum values', async () => {
  const { parseInstallArgs } = await import('./lib.mjs');

  assert.throws(
    () => parseInstallArgs(['--mode', 'wait']),
    /Invalid mode: wait\. Allowed values: pause, exit/,
  );

  assert.throws(
    () => parseInstallArgs(['--deploy-method', 'docker']),
    /Invalid deploy method: docker\. Allowed values: raw, dokploy-compose-api/,
  );
});

test('parseComposeApiArgs reads env file, mode, and prepared flag', async () => {
  const { parseComposeApiArgs } = await import('./lib.mjs');

  assert.deepEqual(
    parseComposeApiArgs(['--env-file', 'custom.env', '--mode', 'exit', '--prepared']),
    {
      envFile: 'custom.env',
      mode: 'exit',
      prepared: true,
    },
  );
});

test('parseComposeApiArgs rejects unsupported mode values', async () => {
  const { parseComposeApiArgs } = await import('./lib.mjs');

  assert.throws(
    () => parseComposeApiArgs(['--mode', 'wait']),
    /Invalid mode: wait\. Allowed values: pause, exit/,
  );
});

test('quoteEnvValue escapes single quotes and wraps values', async () => {
  const { quoteEnvValue } = await import('./lib.mjs');

  assert.equal(quoteEnvValue("a'b c"), "'a'\"'\"'b c'");
});

test('upsertEnvText replaces existing values and appends missing keys', async () => {
  const { upsertEnvText } = await import('./lib.mjs');

  assert.equal(
    upsertEnvText("KEEP='1'\nNAME='old'\n", 'NAME', "new'value"),
    "KEEP='1'\nNAME='new'\"'\"'value'\n",
  );

  assert.equal(
    upsertEnvText("KEEP='1'\n", 'NAME', 'fresh value'),
    "KEEP='1'\nNAME='fresh value'\n",
  );
});

test('loadEnvFile reads quoted values from disk', async () => {
  const { loadEnvFile } = await import('./lib.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, '.env');

  await writeFile(envFile, "NAME='hello world'\nQUOTE='a'\"'\"'b'\nPLAIN=value\n");

  assert.deepEqual(await loadEnvFile(envFile), {
    NAME: 'hello world',
    QUOTE: "a'b",
    PLAIN: 'value',
  });
});

test('createEnvState sets variables and persists them', async () => {
  const { createEnvState } = await import('./lib.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, '.env');

  await writeFile(envFile, "EXISTING='1'\n");

  const envState = await createEnvState(envFile);

  assert.equal(envState.get('EXISTING'), '1');

  await envState.setVar('NAME', "new'value");

  assert.equal(envState.get('NAME'), "new'value");
  assert.equal(await readFile(envFile, 'utf8'), "EXISTING='1'\nNAME='new'\"'\"'value'\n");
});

test('ensureEnvFile creates parent directories for nested env paths', async () => {
  const { ensureEnvFile } = await import('./lib.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'nested', 'deploy.env');

  await ensureEnvFile(envFile);

  assert.equal(await readFile(envFile, 'utf8'), '');
});

test('validate helpers accept supported values', async () => {
  const {
    validateMode,
    validateDeployMethod,
    validateComposeApiMode,
  } = await import('./lib.mjs');

  assert.equal(validateMode('pause'), 'pause');
  assert.equal(validateMode('exit'), 'exit');
  assert.equal(validateDeployMethod('raw'), 'raw');
  assert.equal(validateDeployMethod('dokploy-compose-api'), 'dokploy-compose-api');
  assert.equal(validateComposeApiMode('pause'), 'pause');
  assert.equal(validateComposeApiMode('exit'), 'exit');
});

test('validate helpers reject unsupported values', async () => {
  const {
    validateMode,
    validateDeployMethod,
    validateComposeApiMode,
  } = await import('./lib.mjs');

  assert.throws(() => validateMode('wait'), /Invalid mode: wait\. Allowed values: pause, exit/);
  assert.throws(
    () => validateDeployMethod('docker'),
    /Invalid deploy method: docker\. Allowed values: raw, dokploy-compose-api/,
  );
  assert.throws(
    () => validateComposeApiMode('wait'),
    /Invalid compose api mode: wait\. Allowed values: pause, exit/,
  );
});

test('checkCommandExists uses injected executor and returns true on success', async () => {
  const { checkCommandExists } = await import('./lib.mjs');
  const calls = [];

  const exists = await checkCommandExists('docker', async (...args) => {
    calls.push(args);
    return { code: 0 };
  });

  assert.equal(exists, true);
  assert.deepEqual(calls, [[
    'sh',
    ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', 'docker'],
    { stdio: 'ignore' },
  ]]);
});

test('checkCommandExists returns false when executor rejects', async () => {
  const { checkCommandExists } = await import('./lib.mjs');

  const exists = await checkCommandExists('docker', async () => {
    throw new Error('missing');
  });

  assert.equal(exists, false);
});

test('runCommand uses inherited stdio and resolves on exit code 0', async () => {
  const { runCommand } = await import('./lib.mjs');
  let spawnCall;

  await runCommand('docker', ['compose', 'up'], (command, args, options) => {
    spawnCall = { command, args, options };
    const child = createFakeChild();
    process.nextTick(() => child.emit('close', 0));
    return child;
  });

  assert.deepEqual(spawnCall, {
    command: 'docker',
    args: ['compose', 'up'],
    options: { stdio: 'inherit' },
  });
});

test('runCommandCapture pipes output and returns collected text', async () => {
  const { runCommandCapture } = await import('./lib.mjs');
  let spawnCall;

  const result = await runCommandCapture('docker', ['ps'], (command, args, options) => {
    spawnCall = { command, args, options };
    const child = createFakeChild();
    process.nextTick(() => {
      child.stdout.emit('data', 'stdout line');
      child.stderr.emit('data', Buffer.from('stderr line'));
      child.emit('close', 0);
    });
    return child;
  });

  assert.deepEqual(spawnCall, {
    command: 'docker',
    args: ['ps'],
    options: { stdio: ['ignore', 'pipe', 'pipe'] },
  });
  assert.deepEqual(result, {
    stdout: 'stdout line',
    stderr: 'stderr line',
  });
});

test('runCommand rejects on non-zero exit', async () => {
  const { runCommand } = await import('./lib.mjs');

  await assert.rejects(
    runCommand('docker', ['compose', 'up'], () => {
      const child = createFakeChild();
      process.nextTick(() => child.emit('close', 1));
      return child;
    }),
    /Command exited with code 1/,
  );
});

test('runCommandCapture rejects on child error', async () => {
  const { runCommandCapture } = await import('./lib.mjs');

  await assert.rejects(
    runCommandCapture('docker', ['ps'], () => {
      const child = createFakeChild();
      process.nextTick(() => child.emit('error', new Error('spawn failed')));
      return child;
    }),
    /spawn failed/,
  );
});

test('dokploy request helpers build fetch requests and unwrap json payloads', async () => {
  const { dokployGet, dokployPost } = await import('./lib.mjs');
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          result: {
            data: {
              json: options.method === 'POST' ? { composeId: 'compose-1' } : [{ projectId: 'project-1' }],
            },
          },
        };
      },
    };
  };

  const projects = await dokployGet(
    'https://dokploy.example.com',
    'token-123',
    'project.all',
    { projectId: 'project-1' },
    fetchFn,
  );
  const created = await dokployPost(
    'https://dokploy.example.com',
    'token-123',
    'compose.create',
    { name: 'zrok-instance' },
    fetchFn,
  );

  assert.deepEqual(projects, [{ projectId: 'project-1' }]);
  assert.deepEqual(created, { composeId: 'compose-1' });
  assert.deepEqual(calls, [
    {
      url: 'https://dokploy.example.com/api/trpc/project.all?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-1%22%7D%7D',
      options: {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'token-123',
        },
      },
    },
    {
      url: 'https://dokploy.example.com/api/trpc/compose.create',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'token-123',
        },
        body: '{"json":{"name":"zrok-instance"}}',
      },
    },
  ]);
});

test('dokploy discovery helpers match project, environment, and compose ids', async () => {
  const {
    findProjectIdByName,
    findEnvironmentIdByName,
    findComposeIdInEnvironment,
  } = await import('./lib.mjs');

  const project = {
    environments: [
      {
        name: 'production',
        environmentId: 'env-1',
        compose: [
          { name: 'other', appName: 'other-app', composeId: 'compose-0' },
          { name: 'zrok-instance', appName: 'zrok-app', composeId: 'compose-1' },
        ],
      },
    ],
  };

  assert.equal(
    findProjectIdByName([
      { name: 'demo', projectId: 'project-0' },
      { name: 'zrok', projectId: 'project-1' },
    ], 'zrok'),
    'project-1',
  );
  assert.equal(findEnvironmentIdByName(project, 'production'), 'env-1');
  assert.equal(findComposeIdInEnvironment(project, 'production', 'zrok-instance', 'zrok-app'), 'compose-1');
  assert.equal(findComposeIdInEnvironment(project, 'production', 'missing', 'zrok-app'), 'compose-1');
});

test('dokploy compose helpers create, update, and deploy using env values', async () => {
  const {
    createDokployProject,
    createDokployEnvironment,
    createDokployCompose,
    updateDokployCompose,
    deployDokployCompose,
  } = await import('./lib.mjs');
  const calls = [];
  const postJson = async (endpoint, payload) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'project.create') {
      return { projectId: 'project-1' };
    }
    if (endpoint === 'environment.create') {
      return { environmentId: 'env-1' };
    }
    if (endpoint === 'compose.create') {
      return { composeId: 'compose-1' };
    }
    return {};
  };
  const env = {
    DOKPLOY_PROJECT_NAME: 'zrok',
    DOKPLOY_PROJECT_DESCRIPTION: 'Self-hosted zrok services',
    DOKPLOY_PROJECT_ID: 'project-1',
    DOKPLOY_ENVIRONMENT_NAME: 'production',
    DOKPLOY_ENVIRONMENT_DESCRIPTION: 'Production services',
    DOKPLOY_ENVIRONMENT_ID: 'env-1',
    DOKPLOY_COMPOSE_NAME: 'zrok-instance',
    DOKPLOY_COMPOSE_DESCRIPTION: 'Self-hosted zrok on Dokploy',
    DOKPLOY_COMPOSE_APP_NAME: 'zrok-instance',
    DOKPLOY_COMPOSE_ID: 'compose-1',
  };

  assert.equal(await createDokployProject(env, postJson), 'project-1');
  assert.equal(await createDokployEnvironment(env, postJson), 'env-1');
  assert.equal(await createDokployCompose(env, postJson), 'compose-1');

  await updateDokployCompose(env, { composeYaml: 'services: {}', composeEnv: 'NAME=value' }, postJson);
  await deployDokployCompose(env, postJson);

  assert.deepEqual(calls, [
    {
      endpoint: 'project.create',
      payload: { name: 'zrok', description: 'Self-hosted zrok services' },
    },
    {
      endpoint: 'environment.create',
      payload: {
        name: 'production',
        description: 'Production services',
        projectId: 'project-1',
      },
    },
    {
      endpoint: 'compose.create',
      payload: {
        name: 'zrok-instance',
        description: 'Self-hosted zrok on Dokploy',
        environmentId: 'env-1',
        composeType: 'docker-compose',
        appName: 'zrok-instance',
      },
    },
    {
      endpoint: 'compose.update',
      payload: {
        composeId: 'compose-1',
        sourceType: 'raw',
        composePath: './docker-compose.yml',
        composeFile: 'services: {}',
        env: 'NAME=value',
        name: 'zrok-instance',
        description: 'Self-hosted zrok on Dokploy',
      },
    },
    {
      endpoint: 'compose.deploy',
      payload: {
        composeId: 'compose-1',
        title: 'Install self-hosted zrok',
        description: 'Automated zrok compose deployment',
      },
    },
  ]);
});

test('renderComposeBundle shells out to docker compose config and reads .env', async () => {
  const { renderComposeBundle } = await import('./lib.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const calls = [];

  await writeFile(join(dir, '.env'), 'NAME=value\n');

  const result = await renderComposeBundle(
    dir,
    async (command, args, spawnFn, options) => {
      calls.push({ command, args, spawnFn, options });
      return { stdout: 'services:\n  zrok:\n    image: example\n' };
    },
  );

  assert.deepEqual(result, {
    composeYaml: 'services:\n  zrok:\n    image: example\n',
    composeEnv: 'NAME=value\n',
  });
  assert.deepEqual(calls, [
    {
      command: 'docker',
      args: ['compose', '-f', 'compose.yml', '-f', 'compose.dokploy.yml', 'config'],
      spawnFn: undefined,
      options: { cwd: dir },
    },
  ]);
});

test('renderTemplate substitutes placeholder variables', async () => {
  const { renderTemplate } = await import('./lib.mjs');

  assert.equal(
    renderTemplate('Hello ${NAME}, welcome to ${PLACE}!', {
      NAME: 'Mark',
      PLACE: 'mh-garage',
    }),
    'Hello Mark, welcome to mh-garage!',
  );
});

test('renderTemplate throws a readable error when a variable is missing', async () => {
  const { renderTemplate } = await import('./lib.mjs');

  assert.throws(
    () => renderTemplate('Hello ${NAME}', {}),
    /Missing template variable: NAME/,
  );
});

test('checked-in installer templates exist and keep envsubst placeholders', async () => {
  const frontendTemplatePath = fileURLToPath(new URL('./templates/zrok-frontend-config.yml.envsubst', import.meta.url));
  const zrokEnvTemplatePath = fileURLToPath(new URL('./templates/zrok.env', import.meta.url));
  const dokployComposeTemplatePath = fileURLToPath(new URL('./templates/compose.dokploy.yml', import.meta.url));

  const [frontendTemplate, zrokEnvTemplate, dokployComposeTemplate] = await Promise.all([
    readFile(frontendTemplatePath, 'utf8'),
    readFile(zrokEnvTemplatePath, 'utf8'),
    readFile(dokployComposeTemplatePath, 'utf8'),
  ]);

  assert.equal(
    frontendTemplate,
    'v: 4\n\nhost_match: ${ZROK_DNS_ZONE}\naddress: 0.0.0.0:${ZROK_FRONTEND_PORT}\n',
  );

  assert.equal(
    zrokEnvTemplate,
    [
      'ZROK_DNS_ZONE=${ZROK_DOMAIN}',
      'ZROK_USER_EMAIL=${ZROK_USER_EMAIL}',
      'ZROK_USER_PWD=${ZROK_USER_PWD}',
      'ZROK_ADMIN_TOKEN=${ZROK_ADMIN_TOKEN}',
      'ZITI_PWD=${ZITI_PWD}',
      'ZROK_CTRL_PORT=${ZROK_CTRL_PORT}',
      'ZROK_FRONTEND_PORT=${ZROK_FRONTEND_INTERNAL_PORT}',
      'ZROK_OAUTH_PORT=${ZROK_OAUTH_PORT}',
      'ZITI_CTRL_ADVERTISED_PORT=${ZITI_CTRL_ADVERTISED_PORT}',
      'ZITI_ROUTER_PORT=${ZITI_ROUTER_PORT}',
      'ZROK_INSECURE_INTERFACE=127.0.0.1',
      'ZITI_INTERFACE=0.0.0.0',
      '',
    ].join('\n'),
  );

  assert.equal(
    dokployComposeTemplate,
    [
      'services:',
      '  zrok-controller:',
      '    networks:',
      '      - zrok-instance',
      '      - dokploy-network',
      '    labels:',
      '      - traefik.enable=true',
      "      - 'traefik.http.routers.zrok-controller-web.rule=Host(\"${ZROK_DOMAIN}\")'",
      '      - traefik.http.routers.zrok-controller-web.entrypoints=web',
      '      - traefik.http.routers.zrok-controller-web.middlewares=redirect-to-https@file',
      '      - traefik.http.routers.zrok-controller-web.service=zrok-controller',
      "      - 'traefik.http.routers.zrok-controller-websecure.rule=Host(\"${ZROK_DOMAIN}\")'",
      '      - traefik.http.routers.zrok-controller-websecure.entrypoints=websecure',
      '      - traefik.http.routers.zrok-controller-websecure.tls=true',
      '      - traefik.http.routers.zrok-controller-websecure.tls.certresolver=${TRAEFIK_CERT_RESOLVER}',
      '      - traefik.http.routers.zrok-controller-websecure.service=zrok-controller',
      '      - traefik.http.services.zrok-controller.loadbalancer.server.port=${ZROK_CTRL_PORT}',
      '',
      '  zrok-frontend:',
      '    networks:',
      '      - zrok-instance',
      '      - dokploy-network',
      '    environment:',
      '      ZROK_FRONTEND_SCHEME: https',
      '      ZROK_FRONTEND_PORT: "${ZROK_PUBLIC_HTTPS_PORT}"',
      '    labels:',
      '      - traefik.enable=true',
      "      - 'traefik.http.routers.zrok-frontend-web.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.${ZROK_DOMAIN}\")'",
      '      - traefik.http.routers.zrok-frontend-web.entrypoints=web',
      '      - traefik.http.routers.zrok-frontend-web.middlewares=redirect-to-https@file',
      '      - traefik.http.routers.zrok-frontend-web.service=zrok-frontend',
      "      - 'traefik.http.routers.zrok-frontend-websecure.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.${ZROK_DOMAIN}\")'",
      '      - traefik.http.routers.zrok-frontend-websecure.entrypoints=websecure',
      '      - traefik.http.routers.zrok-frontend-websecure.tls=true',
      '      - traefik.http.routers.zrok-frontend-websecure.tls.certresolver=${TRAEFIK_CERT_RESOLVER}',
      '      - traefik.http.routers.zrok-frontend-websecure.service=zrok-frontend',
      '      - traefik.http.services.zrok-frontend.loadbalancer.server.port=${ZROK_FRONTEND_INTERNAL_PORT}',
      '',
      'networks:',
      '  dokploy-network:',
      '    external: true',
      '',
    ].join('\n'),
  );
});

test('renderInstallerArtifacts renders template-backed installer files with expected values', async () => {
  const { renderInstallerArtifacts } = await import('./lib.mjs');

  const rendered = await renderInstallerArtifacts({
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

  assert.deepEqual(rendered, {
    frontendConfig: 'v: 4\n\nhost_match: ${ZROK_DNS_ZONE}\naddress: 0.0.0.0:${ZROK_FRONTEND_PORT}\n',
    zrokEnv: [
      'ZROK_DNS_ZONE=zrok.example.com',
      'ZROK_USER_EMAIL=admin@example.com',
      'ZROK_USER_PWD=hunter2',
      'ZROK_ADMIN_TOKEN=admin-token-123',
      'ZITI_PWD=ziti-password-456',
      'ZROK_CTRL_PORT=18080',
      'ZROK_FRONTEND_PORT=8080',
      'ZROK_OAUTH_PORT=8081',
      'ZITI_CTRL_ADVERTISED_PORT=1443',
      'ZITI_ROUTER_PORT=3022',
      'ZROK_INSECURE_INTERFACE=127.0.0.1',
      'ZITI_INTERFACE=0.0.0.0',
      '',
    ].join('\n'),
    dokployCompose: [
      'services:',
      '  zrok-controller:',
      '    networks:',
      '      - zrok-instance',
      '      - dokploy-network',
      '    labels:',
      '      - traefik.enable=true',
      "      - 'traefik.http.routers.zrok-controller-web.rule=Host(\"zrok.example.com\")'",
      '      - traefik.http.routers.zrok-controller-web.entrypoints=web',
      '      - traefik.http.routers.zrok-controller-web.middlewares=redirect-to-https@file',
      '      - traefik.http.routers.zrok-controller-web.service=zrok-controller',
      "      - 'traefik.http.routers.zrok-controller-websecure.rule=Host(\"zrok.example.com\")'",
      '      - traefik.http.routers.zrok-controller-websecure.entrypoints=websecure',
      '      - traefik.http.routers.zrok-controller-websecure.tls=true',
      '      - traefik.http.routers.zrok-controller-websecure.tls.certresolver=letsencrypt',
      '      - traefik.http.routers.zrok-controller-websecure.service=zrok-controller',
      '      - traefik.http.services.zrok-controller.loadbalancer.server.port=18080',
      '',
      '  zrok-frontend:',
      '    networks:',
      '      - zrok-instance',
      '      - dokploy-network',
      '    environment:',
      '      ZROK_FRONTEND_SCHEME: https',
      '      ZROK_FRONTEND_PORT: "443"',
      '    labels:',
      '      - traefik.enable=true',
      "      - 'traefik.http.routers.zrok-frontend-web.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.zrok.example.com\")'",
      '      - traefik.http.routers.zrok-frontend-web.entrypoints=web',
      '      - traefik.http.routers.zrok-frontend-web.middlewares=redirect-to-https@file',
      '      - traefik.http.routers.zrok-frontend-web.service=zrok-frontend',
      "      - 'traefik.http.routers.zrok-frontend-websecure.rule=HostRegexp(\"{share:[A-Za-z0-9-]+}.zrok.example.com\")'",
      '      - traefik.http.routers.zrok-frontend-websecure.entrypoints=websecure',
      '      - traefik.http.routers.zrok-frontend-websecure.tls=true',
      '      - traefik.http.routers.zrok-frontend-websecure.tls.certresolver=letsencrypt',
      '      - traefik.http.routers.zrok-frontend-websecure.service=zrok-frontend',
      '      - traefik.http.services.zrok-frontend.loadbalancer.server.port=8080',
      '',
      'networks:',
      '  dokploy-network:',
      '    external: true',
      '',
    ].join('\n'),
  });
});

test('renderInstallerArtifacts fails fast with a readable template file error for missing variables', async () => {
  const { renderInstallerArtifacts } = await import('./lib.mjs');

  await assert.rejects(
    renderInstallerArtifacts({
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
    }),
    /compose\.dokploy\.yml: Missing template variable: ZROK_PUBLIC_HTTPS_PORT/,
  );
});

test('renderInstallerArtifacts treats empty-string required values as missing with a readable template file error', async () => {
  const { renderInstallerArtifacts } = await import('./lib.mjs');

  await assert.rejects(
    renderInstallerArtifacts({
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
      ZROK_PUBLIC_HTTPS_PORT: '',
    }),
    /compose\.dokploy\.yml: Missing template variable: ZROK_PUBLIC_HTTPS_PORT/,
  );
});

test('compose api cli main persists ids after discovery and creation', async () => {
  const { main } = await import('./install-dokploy-compose-api.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, '.env');
  const steps = [];

  await writeFile(
    envFile,
    [
      'DOKPLOY_URL=https://dokploy.example.com',
      'DOKPLOY_API_TOKEN=token-123',
      `ZROK_INSTANCE_DIR=${dir}`,
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile, '--prepared'], {
    stdout: { write() {} },
    stderr: { write() {} },
    fetchFn: async (url, options = {}) => {
      steps.push(['fetch', url, options.method ?? 'GET']);
      if (url.includes('/project.all')) {
        return {
          ok: true,
          async json() {
            return { result: { data: { json: [] } } };
          },
        };
      }

      if (url.includes('/project.one') && options.method !== 'POST') {
        return {
          ok: true,
          async json() {
            return {
              result: {
                data: {
                  json: {
                    environments: [],
                  },
                },
              },
            };
          },
        };
      }

      const endpoint = url.split('/api/trpc/')[1];
      if (endpoint === 'project.create') {
        return {
          ok: true,
          async json() {
            return { result: { data: { json: { projectId: 'project-1' } } } };
          },
        };
      }
      if (endpoint === 'environment.create') {
        return {
          ok: true,
          async json() {
            return { result: { data: { json: { environmentId: 'env-1' } } } };
          },
        };
      }
      if (endpoint === 'compose.create') {
        return {
          ok: true,
          async json() {
            return { result: { data: { json: { composeId: 'compose-1' } } } };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { result: { data: { json: {} } } };
        },
      };
    },
    renderComposeBundle: async (instanceDir) => {
      steps.push(['render', instanceDir]);
      return { composeYaml: 'services: {}', composeEnv: 'NAME=value\n' };
    },
  });

  assert.match(await readFile(envFile, 'utf8'), /DOKPLOY_PROJECT_ID='project-1'/);
  assert.match(await readFile(envFile, 'utf8'), /DOKPLOY_ENVIRONMENT_ID='env-1'/);
  assert.match(await readFile(envFile, 'utf8'), /DOKPLOY_COMPOSE_ID='compose-1'/);
  assert.deepEqual(steps, [
    ['fetch', 'https://dokploy.example.com/api/trpc/project.all', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.create', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-1%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/environment.create', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-1%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.create', 'POST'],
    ['render', dir],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.update', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.deploy', 'POST'],
  ]);
});

test('compose api cli main persists discovered ids without creating resources', async () => {
  const { main } = await import('./install-dokploy-compose-api.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, '.env');
  const steps = [];

  await writeFile(
    envFile,
    [
      'DOKPLOY_URL=https://dokploy.example.com',
      'DOKPLOY_API_TOKEN=token-123',
      `ZROK_INSTANCE_DIR=${dir}`,
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile, '--prepared'], {
    stdout: { write() {} },
    fetchFn: async (url, options = {}) => {
      steps.push(['fetch', url, options.method ?? 'GET']);

      if (url.includes('/project.all')) {
        return {
          ok: true,
          async json() {
            return {
              result: {
                data: {
                  json: [{ name: 'zrok', projectId: 'project-existing' }],
                },
              },
            };
          },
        };
      }

      if (url.includes('/project.one')) {
        return {
          ok: true,
          async json() {
            return {
              result: {
                data: {
                  json: {
                    environments: [
                      {
                        name: 'production',
                        environmentId: 'env-existing',
                        compose: [
                          {
                            name: 'zrok-instance',
                            appName: 'zrok-instance',
                            composeId: 'compose-existing',
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            };
          },
        };
      }

      return {
        ok: true,
        async json() {
          return { result: { data: { json: {} } } };
        },
      };
    },
    renderComposeBundle: async (instanceDir) => {
      steps.push(['render', instanceDir]);
      return { composeYaml: 'services: {}', composeEnv: 'NAME=value\n' };
    },
  });

  const envText = await readFile(envFile, 'utf8');
  assert.match(envText, /DOKPLOY_PROJECT_ID='project-existing'/);
  assert.match(envText, /DOKPLOY_ENVIRONMENT_ID='env-existing'/);
  assert.match(envText, /DOKPLOY_COMPOSE_ID='compose-existing'/);
  assert.deepEqual(steps, [
    ['fetch', 'https://dokploy.example.com/api/trpc/project.all', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-existing%22%7D%7D', 'GET'],
    ['fetch', 'https://dokploy.example.com/api/trpc/project.one?input=%7B%22json%22%3A%7B%22projectId%22%3A%22project-existing%22%7D%7D', 'GET'],
    ['render', dir],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.update', 'POST'],
    ['fetch', 'https://dokploy.example.com/api/trpc/compose.deploy', 'POST'],
  ]);
});

test('compose api cli prints help output', async () => {
  const scriptPath = fileURLToPath(new URL('./install-dokploy-compose-api.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--help']);

  assert.match(stdout, /Usage: install-dokploy-compose-api\.js \[--env-file PATH\] \[--mode pause\|exit\] \[--prepared\]/);
  assert.equal(stderr, '');
});

test('requireRootLinux rejects non-root users and non-Linux hosts', async () => {
  const { requireRootLinux } = await import('./lib.mjs');

  assert.throws(() => requireRootLinux({ uid: 1000, platform: 'Linux' }), /This script must run as root\./);
  assert.throws(() => requireRootLinux({ uid: 0, platform: 'Darwin' }), /This script only supports Linux hosts\./);
});

test('lib no longer exports ensureNodeForDokployCli', async () => {
  const lib = await import('./lib.mjs');

  assert.equal('ensureNodeForDokployCli' in lib, false);
});

test('install cli main runs raw deployment flow and persists generated artifacts', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'deploy.env');
  const instanceDir = join(dir, 'instance');
  const writes = [];
  const output = [];

  await writeFile(
    envFile,
    [
      `ZROK_INSTANCE_DIR=${instanceDir}`,
      'INSTALL_DOKPLOY_CLI=false',
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile], {
    stdout: { write(chunk) { output.push(chunk); } },
    stderr: { write(chunk) { output.push(chunk); } },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => {
      const values = ['admin-token-123', 'ziti-password-456'];
      return () => values.shift();
    })(),
    promptForValue: async ({ key }) => {
      if (key === 'DOKPLOY_DOMAIN') return 'dokploy.example.com';
      if (key === 'ZROK_DOMAIN') return 'zrok.example.com';
      if (key === 'ZROK_USER_EMAIL') return 'admin@example.com';
      if (key === 'ZROK_USER_PWD') return 'hunter2';
      throw new Error(`Unexpected prompt for ${key}`);
    },
    pauseOrExit: async (message) => {
      writes.push(['pause', message]);
    },
    ensureDokployInstalled: async () => {
      writes.push(['install-dokploy']);
    },
    waitForDokploy: async () => {
      writes.push(['wait-dokploy']);
    },
    getPublicIp: async () => '203.0.113.10',
    hostResolvesTo: async (host, ip) => {
      writes.push(['resolve', host, ip]);
      return true;
    },
    httpsOk: async (url) => {
      writes.push(['https', url]);
      return true;
    },
    fetchZrokProject: async (targetDir) => {
      writes.push(['fetch-project', targetDir]);
      await writeFile(join(targetDir, 'compose.yml'), 'services:\n  zrok-controller: {}\n');
    },
    deployRaw: async (targetDir) => {
      writes.push(['deploy-raw', targetDir]);
    },
    createZrokAccount: async ({ email, instanceDir: targetDir }) => {
      writes.push(['create-account', email, targetDir]);
      return 'account-token-789';
    },
  });

  const envText = await readFile(envFile, 'utf8');
  assert.match(envText, /DOKPLOY_URL='https:\/\/dokploy\.example\.com'/);
  assert.match(envText, /ZROK_ADMIN_TOKEN='admin-token-123'/);
  assert.match(envText, /ZITI_PWD='ziti-password-456'/);
  assert.match(envText, /ZROK_ACCOUNT_TOKEN='account-token-789'/);

  assert.match(
    await readFile(join(instanceDir, 'zrok-frontend-config.yml.envsubst'), 'utf8'),
    /host_match: \$\{ZROK_DNS_ZONE\}/,
  );
  assert.match(await readFile(join(instanceDir, '.env'), 'utf8'), /ZROK_DNS_ZONE=zrok\.example\.com/);
  assert.match(await readFile(join(instanceDir, 'compose.dokploy.yml'), 'utf8'), /dokploy-network:/);
  assert.match(await readFile(join(instanceDir, '.installer-state/zrok-account-token'), 'utf8'), /account-token-789/);

  assert.deepEqual(writes, [
    ['install-dokploy'],
    ['wait-dokploy'],
    ['pause', 'Manual checkpoint: open http://203.0.113.10:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.'],
    ['resolve', 'dokploy.example.com', '203.0.113.10'],
    ['https', 'https://dokploy.example.com'],
    ['fetch-project', instanceDir],
    ['resolve', 'zrok.example.com', '203.0.113.10'],
    ['resolve', 'probe.zrok.example.com', '203.0.113.10'],
    ['deploy-raw', instanceDir],
    ['pause', `Next manual checkpoint: the script is ready to create the first zrok account using admin@example.com. If you want to change the email or password, edit ${envFile} now.`],
    ['create-account', 'admin@example.com', instanceDir],
  ]);
  assert.match(output.join(''), /Detected public IP: 203\.0\.113\.10/);
  assert.match(output.join(''), /zrok controller URL: https:\/\/zrok\.example\.com/);
});

test('install cli main delegates Dokploy Compose API deployment without ensureNodeForDokployCli and installs cli when missing', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'deploy.env');
  const instanceDir = join(dir, 'instance');
  const writes = [];
  const commandChecks = [];

  await writeFile(
    envFile,
    [
      'DOKPLOY_DOMAIN=dokploy.example.com',
      'DOKPLOY_URL=https://dokploy.example.com',
      'DOKPLOY_API_TOKEN=token-123',
      'ZROK_DOMAIN=zrok.example.com',
      'ZROK_USER_EMAIL=admin@example.com',
      'ZROK_USER_PWD=hunter2',
      `ZROK_INSTANCE_DIR=${instanceDir}`,
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile, '--deploy-method', 'dokploy-compose-api'], {
    stdout: { write() {} },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => {
      const values = ['admin-token-123', 'ziti-password-456'];
      return () => values.shift();
    })(),
    checkCommandExists: async (command) => {
      commandChecks.push(command);
      return command !== 'dokploy';
    },
    checkNodeMajorVersion: async () => {
      throw new Error('should not check node version');
    },
    ensureDokployInstalled: async () => {
      writes.push(['install-dokploy']);
    },
    waitForDokploy: async () => {
      writes.push(['wait-dokploy']);
    },
    getPublicIp: async () => '',
    httpsOk: async () => true,
    installDokployCli: async () => {
      writes.push(['install-dokploy-cli']);
    },
    authenticateDokployCli: async (url, token) => {
      writes.push(['auth-dokploy-cli', url, token]);
    },
    fetchZrokProject: async (targetDir) => {
      writes.push(['fetch-project', targetDir]);
      await writeFile(join(targetDir, 'compose.yml'), 'services:\n  zrok-controller: {}\n');
    },
    delegateComposeApi: async (args) => {
      writes.push(['delegate-compose-api', args]);
    },
    createZrokAccount: async () => 'account-token-789',
    pauseOrExit: async (message) => {
      writes.push(['pause', message]);
    },
    hostResolvesTo: async () => true,
  });

  assert.deepEqual(writes, [
    ['install-dokploy'],
    ['wait-dokploy'],
    ['pause', 'Manual checkpoint: open http://127.0.0.1:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token.'],
    ['install-dokploy-cli'],
    ['auth-dokploy-cli', 'https://dokploy.example.com', 'token-123'],
    ['fetch-project', instanceDir],
    ['delegate-compose-api', ['--env-file', envFile, '--mode', 'pause', '--prepared']],
    ['pause', `Next manual checkpoint: the script is ready to create the first zrok account using admin@example.com. If you want to change the email or password, edit ${envFile} now.`],
  ]);
  assert.deepEqual(commandChecks, ['dokploy']);
});

test('install cli main lets cli mode override MODE from env file', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'mode.env');
  const output = [];

  await writeFile(envFile, "MODE='pause'\n");

  await assert.rejects(
    main(['--env-file', envFile, '--mode', 'exit'], {
      stdout: { write(chunk) { output.push(chunk); } },
      stderr: { write() {} },
      getUid: () => 0,
      getPlatform: () => 'Linux',
      promptForValue: async () => {
        throw new Error('prompt should not run');
      },
    }),
    /Installer exited at a manual checkpoint/,
  );

  assert.match(output.join(''), /Manual input required for DOKPLOY_DOMAIN/);
});

test('install cli main honors MODE and DEPLOY_METHOD from env file when CLI omits them', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'env-precedence.env');
  const output = [];

  await writeFile(envFile, "MODE='exit'\nDEPLOY_METHOD='dokploy-compose-api'\n");

  await assert.rejects(
    main(['--env-file', envFile], {
      stdout: { write(chunk) { output.push(chunk); } },
      stderr: { write() {} },
      getUid: () => 0,
      getPlatform: () => 'Linux',
      promptForValue: async () => {
        throw new Error('prompt should not run');
      },
    }),
    /Installer exited at a manual checkpoint/,
  );

  const envText = await readFile(envFile, 'utf8');
  assert.match(output.join(''), /Manual input required for DOKPLOY_DOMAIN/);
  assert.match(envText, /DEPLOY_METHOD='dokploy-compose-api'/);
});

test('install cli main skips Dokploy CLI install when dokploy already exists', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'existing-dokploy.env');
  const instanceDir = join(dir, 'instance');
  const writes = [];
  const commandChecks = [];

  await writeFile(
    envFile,
    [
      'DOKPLOY_DOMAIN=dokploy.example.com',
      'DOKPLOY_URL=https://dokploy.example.com',
      'DOKPLOY_API_TOKEN=token-123',
      'ZROK_DOMAIN=zrok.example.com',
      'ZROK_USER_EMAIL=admin@example.com',
      'ZROK_USER_PWD=hunter2',
      `ZROK_INSTANCE_DIR=${instanceDir}`,
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile, '--deploy-method', 'dokploy-compose-api'], {
    stdout: { write() {} },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => {
      const values = ['admin-token-123', 'ziti-password-456'];
      return () => values.shift();
    })(),
    checkCommandExists: async (command) => {
      commandChecks.push(command);
      return true;
    },
    checkNodeMajorVersion: async () => {
      throw new Error('should not check node version');
    },
    ensureDokployInstalled: async () => {},
    waitForDokploy: async () => {},
    getPublicIp: async () => '',
    httpsOk: async () => true,
    installDokployCli: async () => {
      writes.push(['install-dokploy-cli']);
    },
    authenticateDokployCli: async () => {},
    fetchZrokProject: async (targetDir) => {
      await writeFile(join(targetDir, 'compose.yml'), 'services:\n  zrok-controller: {}\n');
    },
    delegateComposeApi: async () => {},
    createZrokAccount: async () => 'account-token-789',
    pauseOrExit: async () => {},
    hostResolvesTo: async () => true,
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(commandChecks, ['dokploy']);
});

test('install cli main persists existing zrok account token to state file and summary', async () => {
  const { main } = await import('./install.js');
  const dir = await mkdtemp(join(tmpdir(), 'install-test-'));
  const envFile = join(dir, 'existing-token.env');
  const instanceDir = join(dir, 'instance');
  const output = [];
  const writes = [];

  await writeFile(
    envFile,
    [
      'DOKPLOY_DOMAIN=dokploy.example.com',
      'DOKPLOY_URL=https://dokploy.example.com',
      'ZROK_DOMAIN=zrok.example.com',
      'ZROK_USER_EMAIL=admin@example.com',
      'ZROK_USER_PWD=hunter2',
      'ZROK_ACCOUNT_TOKEN=account-token-789',
      'INSTALL_DOKPLOY_CLI=false',
      `ZROK_INSTANCE_DIR=${instanceDir}`,
      '',
    ].join('\n'),
  );

  await main(['--env-file', envFile], {
    stdout: { write(chunk) { output.push(chunk); } },
    stderr: { write() {} },
    getUid: () => 0,
    getPlatform: () => 'Linux',
    randomToken: (() => {
      const values = ['admin-token-123', 'ziti-password-456'];
      return () => values.shift();
    })(),
    promptForValue: async ({ key }) => {
      throw new Error(`Unexpected prompt for ${key}`);
    },
    pauseOrExit: async (message) => {
      writes.push(['pause', message]);
    },
    ensureDokployInstalled: async () => {
      writes.push(['install-dokploy']);
    },
    waitForDokploy: async () => {
      writes.push(['wait-dokploy']);
    },
    getPublicIp: async () => '203.0.113.10',
    hostResolvesTo: async () => true,
    httpsOk: async () => true,
    fetchZrokProject: async (targetDir) => {
      await writeFile(join(targetDir, 'compose.yml'), 'services:\n  zrok-controller: {}\n');
    },
    deployRaw: async () => {},
    createZrokAccount: async () => {
      throw new Error('should not create account');
    },
  });

  assert.match(await readFile(join(instanceDir, '.installer-state/zrok-account-token'), 'utf8'), /account-token-789/);
  assert.match(output.join(''), /zrok account token file: /);
  assert.equal(
    writes.some((entry) => entry[0] === 'pause' && String(entry[1]).includes('ready to create the first zrok account')),
    false,
  );
});

test('install cli prints help output', async () => {
  const scriptPath = fileURLToPath(new URL('./install.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, '--help']);

  assert.match(stdout, /Usage: install\.js \[--env-file PATH\] \[--mode pause\|exit\] \[--deploy-method raw\|dokploy-compose-api\]/);
  assert.equal(stderr, '');
});
