function normalizeDokployUrl(baseUrl) {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

async function parseDokployResponse(response) {
  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    throw new Error(body || `Dokploy request failed with status ${response.status}`);
  }

  return response.json();
}

function appendQueryParams(url, input) {
  if (input == null) {
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    if (value != null) {
      url.searchParams.set(key, String(value));
    }
  }
}

function matchProjectIdByName(projects, name) {
  return projects.find((project) => project.name === name)?.projectId ?? '';
}

function matchEnvironmentIdByName(project, name) {
  return project.environments?.find((environment) => environment.name === name)?.environmentId ?? '';
}

function matchComposeIdInEnvironment(project, environmentName, composeName, composeAppName) {
  const environment = project.environments?.find((entry) => entry.name === environmentName);
  return environment?.compose?.find(
    (compose) => compose.name === composeName || compose.appName === composeAppName,
  )?.composeId ?? '';
}

/**
 * Creates a Dokploy API client that hides endpoint and auth details behind resource-level helpers.
 * @param {{ baseUrl: string, apiToken: string, fetchFn?: typeof fetch }} options
 */
export function createDokployClient({ baseUrl, apiToken, fetchFn = fetch }) {
  async function get(endpoint, input) {
    const url = new URL(`${normalizeDokployUrl(baseUrl)}/api/${endpoint}`);
    appendQueryParams(url, input);

    return parseDokployResponse(await fetchFn(url.toString(), {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiToken,
      },
    }));
  }

  async function post(endpoint, payload) {
    return parseDokployResponse(await fetchFn(`${normalizeDokployUrl(baseUrl)}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiToken,
      },
      body: JSON.stringify(payload),
    }));
  }

  async function getProject(projectId) {
    return get('project.one', { projectId });
  }

  return {
    async findProjectIdByName(name) {
      return matchProjectIdByName(await get('project.all'), name);
    },

    async findEnvironmentIdByName(projectId, name) {
      return matchEnvironmentIdByName(await getProject(projectId), name);
    },

    async findComposeIdInEnvironment(projectId, environmentName, composeName, composeAppName) {
      return matchComposeIdInEnvironment(
        await getProject(projectId),
        environmentName,
        composeName,
        composeAppName,
      );
    },

    async createProject(env) {
      const result = await post('project.create', {
        name: env.DOKPLOY_PROJECT_NAME,
        description: env.DOKPLOY_PROJECT_DESCRIPTION,
      });
      return result.projectId;
    },

    async createEnvironment(env) {
      const result = await post('environment.create', {
        name: env.DOKPLOY_ENVIRONMENT_NAME,
        description: env.DOKPLOY_ENVIRONMENT_DESCRIPTION,
        projectId: env.DOKPLOY_PROJECT_ID,
      });
      return result.environmentId;
    },

    async createCompose(env) {
      const result = await post('compose.create', {
        name: env.DOKPLOY_COMPOSE_NAME,
        description: env.DOKPLOY_COMPOSE_DESCRIPTION,
        environmentId: env.DOKPLOY_ENVIRONMENT_ID,
        composeType: 'docker-compose',
        appName: env.DOKPLOY_COMPOSE_APP_NAME,
      });
      return result.composeId;
    },

    async updateCompose(env, bundle) {
      await post('compose.update', {
        composeId: env.DOKPLOY_COMPOSE_ID,
        sourceType: 'raw',
        composePath: './docker-compose.yml',
        composeFile: bundle.composeYaml,
        env: bundle.composeEnv,
        name: env.DOKPLOY_COMPOSE_NAME,
        description: env.DOKPLOY_COMPOSE_DESCRIPTION,
      });
    },

    async deployCompose(env) {
      await post('compose.deploy', {
        composeId: env.DOKPLOY_COMPOSE_ID,
        title: 'Install self-hosted zrok',
        description: 'Automated zrok compose deployment',
      });
    },
  };
}
