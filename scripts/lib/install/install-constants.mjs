export const HELP_TEXT = `Usage: install.js [--env-file PATH] [--mode pause|exit] [--deploy-method raw|dokploy-compose-api]

Options:
  --env-file PATH   Load and persist variables in this env file
  --mode MODE       pause (default) or exit when manual input is needed
  --deploy-method   raw (default) or dokploy-compose-api
  --help            Show this help message
`;

export const DEFAULTS = {
  INSTALL_DOKPLOY_CLI: 'true',
  ZROK_INSTANCE_DIR: '/opt/zrok-instance',
  TRAEFIK_CERT_RESOLVER: 'letsencrypt',
  ZROK_CTRL_PORT: '18080',
  ZROK_FRONTEND_INTERNAL_PORT: '8080',
  ZROK_PUBLIC_HTTPS_PORT: '443',
  ZROK_OAUTH_PORT: '8081',
  ZITI_CTRL_ADVERTISED_PORT: '1443',
  ZITI_ROUTER_PORT: '3022',
};

export const ENV_SNAPSHOT_KEYS = [
  'INSTALL_DOKPLOY_CLI',
  'DOKPLOY_DOMAIN',
  'DOKPLOY_URL',
  'DOKPLOY_API_TOKEN',
  'DOKPLOY_VERSION',
  'ADVERTISE_ADDR',
  'DOCKER_SWARM_INIT_ARGS',
  'DEPLOY_METHOD',
  'ZROK_DOMAIN',
  'ZROK_INSTANCE_DIR',
  'TRAEFIK_CERT_RESOLVER',
  'ZROK_CTRL_PORT',
  'ZROK_FRONTEND_INTERNAL_PORT',
  'ZROK_PUBLIC_HTTPS_PORT',
  'ZROK_OAUTH_PORT',
  'ZITI_CTRL_ADVERTISED_PORT',
  'ZITI_ROUTER_PORT',
  'ZROK_ADMIN_TOKEN',
  'ZITI_PWD',
  'ZROK_USER_EMAIL',
  'ZROK_USER_PWD',
  'ZROK_ACCOUNT_TOKEN',
  'DOKPLOY_COMPOSE_APP_NAME',
];
