const MODE_VALUES = ['pause', 'exit'];
const DEPLOY_METHOD_VALUES = ['raw', 'dokploy-compose-api'];

function requireEnumValue(label, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`Invalid ${label}: ${value}. Allowed values: ${allowedValues.join(', ')}`);
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

export function validateMode(mode) {
  return requireEnumValue('mode', mode, MODE_VALUES);
}

export function validateDeployMethod(method) {
  return requireEnumValue('deploy method', method, DEPLOY_METHOD_VALUES);
}

export function validateComposeApiMode(mode) {
  return requireEnumValue('compose api mode', mode, MODE_VALUES);
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
