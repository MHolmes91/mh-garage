import assert from 'node:assert/strict';
import test from 'node:test';

test('dokploy client binds auth details and unwraps resource requests', async () => {
  const { createDokployClient } = await import('./dokploy-client.mjs');
  const requestLog = [];
  const fetchFn = async (url, options = {}) => {
    requestLog.push({ url, options });
    return {
      ok: true,
      async json() {
        return {
          result: {
            data: {
              json: options.method === 'POST' ? { composeId: 'compose-1' } : [{ name: 'project-1', projectId: 'project-1' }],
            },
          },
        };
      },
    };
  };

  const dokployClient = createDokployClient({ baseUrl: 'https://dokploy.example.com', apiToken: 'token-123', fetchFn });
  const projectId = await dokployClient.findProjectIdByName('project-1');
  const composeId = await dokployClient.createCompose({
    DOKPLOY_COMPOSE_NAME: 'zrok-instance',
    DOKPLOY_COMPOSE_DESCRIPTION: 'Self-hosted zrok on Dokploy',
    DOKPLOY_ENVIRONMENT_ID: 'env-1',
    DOKPLOY_COMPOSE_APP_NAME: 'zrok-instance',
  });

  assert.equal(projectId, 'project-1');
  assert.equal(composeId, 'compose-1');
  assert.deepEqual(requestLog, [
    {
      url: 'https://dokploy.example.com/api/trpc/project.all',
      options: { headers: { 'Content-Type': 'application/json', 'x-api-key': 'token-123' } },
    },
    {
      url: 'https://dokploy.example.com/api/trpc/compose.create',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'token-123' },
        body: '{"json":{"name":"zrok-instance","description":"Self-hosted zrok on Dokploy","environmentId":"env-1","composeType":"docker-compose","appName":"zrok-instance"}}',
      },
    },
  ]);
});

test('dokploy client discovers project, environment, and compose ids', async () => {
  const { createDokployClient } = await import('./dokploy-client.mjs');
  const fetchFn = async (url) => {
    if (url.includes('/project.all')) {
      return {
        ok: true,
        async json() {
          return { result: { data: { json: [{ name: 'demo', projectId: 'project-0' }, { name: 'zrok', projectId: 'project-1' }] } } };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return {
          result: {
            data: {
              json: {
                environments: [{
                  name: 'production',
                  environmentId: 'env-1',
                  compose: [{ name: 'other', appName: 'other-app', composeId: 'compose-0' }, { name: 'zrok-instance', appName: 'zrok-app', composeId: 'compose-1' }],
                }],
              },
            },
          },
        };
      },
    };
  };

  const dokployClient = createDokployClient({ baseUrl: 'https://dokploy.example.com', apiToken: 'token-123', fetchFn });
  assert.equal(await dokployClient.findProjectIdByName('zrok'), 'project-1');
  assert.equal(await dokployClient.findEnvironmentIdByName('project-1', 'production'), 'env-1');
  assert.equal(await dokployClient.findComposeIdInEnvironment('project-1', 'production', 'zrok-instance', 'zrok-app'), 'compose-1');
  assert.equal(await dokployClient.findComposeIdInEnvironment('project-1', 'production', 'missing', 'zrok-app'), 'compose-1');
});

test('dokploy client create, update, and deploy helpers use env values', async () => {
  const { createDokployClient } = await import('./dokploy-client.mjs');
  const requestLog = [];
  const dokployClient = createDokployClient({
    baseUrl: 'https://dokploy.example.com',
    apiToken: 'token-123',
    fetchFn: async (url, options = {}) => {
      const endpoint = url.split('/api/trpc/')[1];
      requestLog.push({ endpoint, payload: options.body ? JSON.parse(options.body).json : undefined });
      if (endpoint === 'project.create') return { ok: true, async json() { return { result: { data: { json: { projectId: 'project-1' } } } }; } };
      if (endpoint === 'environment.create') return { ok: true, async json() { return { result: { data: { json: { environmentId: 'env-1' } } } }; } };
      if (endpoint === 'compose.create') return { ok: true, async json() { return { result: { data: { json: { composeId: 'compose-1' } } } }; } };
      return { ok: true, async json() { return { result: { data: { json: {} } } }; } };
    },
  });
  const envConfig = {
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

  assert.equal(await dokployClient.createProject(envConfig), 'project-1');
  assert.equal(await dokployClient.createEnvironment(envConfig), 'env-1');
  assert.equal(await dokployClient.createCompose(envConfig), 'compose-1');
  await dokployClient.updateCompose(envConfig, { composeYaml: 'services: {}', composeEnv: 'NAME=value' });
  await dokployClient.deployCompose(envConfig);

  assert.deepEqual(requestLog, [
    { endpoint: 'project.create', payload: { name: 'zrok', description: 'Self-hosted zrok services' } },
    { endpoint: 'environment.create', payload: { name: 'production', description: 'Production services', projectId: 'project-1' } },
    { endpoint: 'compose.create', payload: { name: 'zrok-instance', description: 'Self-hosted zrok on Dokploy', environmentId: 'env-1', composeType: 'docker-compose', appName: 'zrok-instance' } },
    { endpoint: 'compose.update', payload: { composeId: 'compose-1', sourceType: 'raw', composePath: './docker-compose.yml', composeFile: 'services: {}', env: 'NAME=value', name: 'zrok-instance', description: 'Self-hosted zrok on Dokploy' } },
    { endpoint: 'compose.deploy', payload: { composeId: 'compose-1', title: 'Install self-hosted zrok', description: 'Automated zrok compose deployment' } },
  ]);
});
