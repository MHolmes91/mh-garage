# mh-garage

Automation and templates for self-hosting zrok on a Linux VPS, with Dokploy as the public edge.

## What this repo does

This repo focuses on one job:

- install Dokploy on a Linux host
- prepare a self-hosted zrok instance
- route zrok through Dokploy's Traefik
- optionally register the zrok stack as a Dokploy-managed Compose app

The main workflow is a resumable host-side installer driven by env-file state.

## Requirements

- Linux host or VPS
- root access on that host
- public IP address
- a domain you control
- ports `80`, `443`, and `3000` available for Dokploy
- ports `1443` and `3022` available for the default zrok/OpenZiti setup

If you keep `INSTALL_DOKPLOY_CLI='true'`, you also need Node.js 18+ and `npm` on the target machine so the installer can install `@dokploy/cli`.

## Repo layout

- `scripts/install.js` - main host installer
- `scripts/install-dokploy-compose-api.js` - experimental Dokploy API deployment helper
- `scripts/.env.example` - starting env file template
- `scripts/templates/` - generated zrok config templates
- `scripts/lib/` - shared helpers, Dokploy client, installer modules, and colocated tests
- `docs/plans/architecture-plan.md` - architecture and manual background

## Install dependencies

This repo uses only Node's built-in runtime for execution and tests.

```bash
npm test
```

## Quick start

1. Copy the example env file.

```bash
cp scripts/.env.example deploy.env
```

2. Edit at least these values in `deploy.env`:

- `DOKPLOY_DOMAIN`
- `DOKPLOY_URL`
- `ZROK_DOMAIN`
- optionally `ZROK_INSTANCE_DIR`

3. Run the installer as root on the target host.

```bash
sudo npm run install:host -- --env-file deploy.env
```

4. Follow the manual checkpoints when prompted:

- open `http://<server-ip>:3000`
- create the first Dokploy admin user
- create a Dokploy API token
- point DNS at the host
- confirm Dokploy HTTPS works

5. Re-run the same command as needed. The installer persists progress into the env file and the zrok instance state directory.

## Deployment modes

### Raw host deployment

Default mode:

```dotenv
DEPLOY_METHOD='raw'
```

This fetches the official `zrok-instance` project and deploys it with Docker Compose on the host.

### Dokploy-managed Compose deployment

Experimental mode:

```dotenv
DEPLOY_METHOD='dokploy-compose-api'
```

With this mode, `scripts/install.js` prepares the zrok project and then delegates to:

```bash
npm run install:dokploy-compose-api -- --env-file deploy.env --mode pause --prepared
```

That helper creates or reuses Dokploy project/environment/compose resources and stores discovered IDs back into the env file.

## Env file notes

Start from `scripts/.env.example`.

There are three kinds of values in it:

- user config - domains, ports, deployment mode, CLI behavior
- optional advanced overrides - like `ADVERTISE_ADDR` or `DOCKER_SWARM_INIT_ARGS`
- installer-managed state - like `DOKPLOY_PROJECT_ID`, `DOKPLOY_ENVIRONMENT_ID`, and `DOKPLOY_COMPOSE_ID`

The commented-out IDs near the bottom are normally written by the installer. They are shown there so you know they exist, but you usually do not set them by hand.

## Available scripts

```bash
npm run install:host -- --env-file deploy.env
npm run install:dokploy-compose-api -- --env-file deploy.env --prepared
npm test
```

## Testing

Run the full test suite with:

```bash
npm test
```

Tests live next to the modules they cover where practical, especially under `scripts/lib/`.

## More background

For the full architecture and manual setup reasoning, see `docs/plans/architecture-plan.md`.
