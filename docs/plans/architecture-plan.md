# Self-host zrok on a Dokploy server

_Last updated: 2026-03-12_

## What this document builds

This plan starts from a bare Linux VPS, installs Dokploy with the official install script, and then self-hosts zrok on the same server.

If you want to execute the plan with a resumable server-side helper, use `scripts/install.sh` with `scripts/.env.example` as the starting env file. For the default host-side deployment, keep `DEPLOY_METHOD='raw'`. If you want the zrok stack to become a Dokploy-managed Docker Compose app instead, set `DEPLOY_METHOD='dokploy-compose-api'` to enable the experimental API-backed path.

Dokploy remains the public edge on ports `80` and `443`.
zrok is self-hosted behind Dokploy's Traefik for:

- `zrok.example.com` for the zrok controller/API
- `*.zrok.example.com` for dynamic public share hostnames

### Build Summary

- bare Linux VPS
- Dokploy installed first with the official install script
- Dokploy CLI installed on the server for later administration
- initial Dokploy admin created through the web setup flow
- self-hosted zrok deployed on the same machine

## Important reality check

Two points matter up front:

1. Dokploy's documented install flow creates the first admin user in the web UI at `http://<server-ip>:3000`
2. The current Dokploy CLI is an authenticated management client; it expects an existing server URL and API token, so it does not replace the initial admin bootstrap step

So the correct order is:

1. install Dokploy
2. open the setup page
3. create the first admin user there
4. install and authenticate the Dokploy CLI afterward

---

## Final architecture

```text
Internet
  |
DNS
  |-- dokploy.example.com ----------------------> VPS IP
  |-- zrok.example.com -------------------------> VPS IP
  |-- *.zrok.example.com -----------------------> VPS IP
  |
Dokploy Traefik (ports 80/443)
  |-- dokploy.example.com ----------------------> Dokploy panel
  |-- zrok.example.com -------------------------> zrok controller
  |-- {share}.zrok.example.com -----------------> zrok frontend
  |
Dokploy-managed zrok stack
  |-- zrok-controller
  |-- zrok-frontend
  |-- ziti-quickstart
  |
Directly published OpenZiti ports
  |-- 1443/tcp (Ziti control plane example)
  |-- 3022/tcp (Ziti router data plane)
```

## Why this design

- Dokploy keeps ownership of the public HTTP/TLS edge
- zrok is self-hosted on your own infrastructure
- wildcard share hostnames stay under your own domain
- the official zrok Docker deployment model is compatible with running on the same VPS as Dokploy if Dokploy remains the only public HTTP/TLS edge

---

# Prerequisites

## Infrastructure

- 1 Linux VPS with a public IP
- at least 2 GB RAM and 30 GB disk for Dokploy's baseline guidance
- a domain you control, such as `example.com`

## Ports

These must be available before installing Dokploy:

- `80/tcp`
- `443/tcp`
- `3000/tcp`

These should also be available for self-hosted zrok/OpenZiti:

- `1443/tcp` for the OpenZiti control plane example in this guide
- `3022/tcp` for the OpenZiti router data plane

`1443` is used here on purpose so it does not collide with Dokploy's use of `443`.

## DNS

Create these records before you wire up TLS and routing:

| Type | Name                  | Value         |
| ---- | --------------------- | ------------- |
| A    | `dokploy.example.com` | `YOUR_VPS_IP` |
| A    | `zrok.example.com`    | `YOUR_VPS_IP` |
| A    | `*.zrok.example.com`  | `YOUR_VPS_IP` |

The wildcard record covers dynamic public share hosts such as `abc123.zrok.example.com` and also names like `ziti.zrok.example.com`.

## Server packages

Dokploy installs Docker for you if needed.

If you want the Dokploy CLI on the server, also install Node.js `18+` so `npm` is available.

---

# Step-by-step build

## Step 1. Install Dokploy first

On the bare Linux VPS, run the official installer as root:

```bash
curl -sSL https://dokploy.com/install.sh | sh
```

Dokploy installs Docker if necessary, initializes Docker Swarm, creates `dokploy-network`, and starts Dokploy plus Traefik.

After install:

1. wait for the services to come up
2. open `http://YOUR_SERVER_IP:3000`
3. confirm the setup page loads

## Step 2. Create the initial Dokploy admin user

Create the first admin account in the Dokploy web setup flow.

This is the documented bootstrap path.

Do not plan on using the Dokploy CLI for this first user creation step. The current CLI expects an existing server URL and API token and is used after the panel is already initialized.

## Step 3. Point a real domain at Dokploy

Before doing more work, point `dokploy.example.com` at the VPS and configure it in Dokploy so the panel is available over HTTPS.

Once the panel works on a real domain, you can optionally remove the raw `:3000` exposure later.

This is a panel step, not a Dokploy CLI step.

## Step 4. Install the Dokploy CLI

On the VPS or your workstation, install Node.js `18+` if needed, then install the CLI:

```bash
npm install -g @dokploy/cli
```

After you log into the Dokploy UI, create an API token in the panel, then authenticate the CLI:

```bash
dokploy authenticate
```

You will need:

- your Dokploy URL, for example `https://dokploy.example.com`
- an API token from the Dokploy panel

You can verify the saved credentials with:

```bash
dokploy verify
```

## Step 5. Use the official zrok self-hosted Docker project as the base

Use the official `zrok-instance` Docker Compose project from the zrok repository as the starting point.

Fetch it on a workstation or directly on the server:

```bash
mkdir -p /opt/zrok-instance
cd /opt/zrok-instance
curl https://get.openziti.io/zrok-instance/fetch.bash | bash
```

Important for this Dokploy-based design:

- use the base `compose.yml`
- do not enable zrok's extra edge-proxy overlay files
- Dokploy's Traefik is the only HTTP/TLS edge in this plan

## Step 6. Create the zrok environment file

Create `.env` in the `zrok-instance` project with values like these:

```dotenv
ZROK_DNS_ZONE=zrok.example.com
ZROK_USER_EMAIL=admin@example.com
ZROK_USER_PWD=CHANGE_ME_ZROK_UI_PASSWORD
ZROK_ADMIN_TOKEN=CHANGE_ME_LONG_RANDOM_TOKEN
ZITI_PWD=CHANGE_ME_LONG_RANDOM_PASSWORD

ZROK_CTRL_PORT=18080
ZROK_FRONTEND_PORT=443
ZROK_OAUTH_PORT=8081

ZITI_CTRL_ADVERTISED_PORT=1443
ZITI_ROUTER_PORT=3022

ZROK_INSECURE_INTERFACE=127.0.0.1
ZITI_INTERFACE=0.0.0.0
```

Notes:

- `ZROK_FRONTEND_PORT=443` makes the frontend generate clean HTTPS share URLs without `:8080`
- `ZROK_INSECURE_INTERFACE=127.0.0.1` keeps the controller/frontend host bindings off the public interface
- `ZITI_INTERFACE=0.0.0.0` keeps the OpenZiti listener ports reachable from outside the server
- `ZITI_CTRL_ADVERTISED_PORT=1443` avoids conflict with Dokploy's `443`

## Step 7. Remove OAuth config if you are not using it

The zrok Docker guide explicitly notes that if you are not using OAuth for public shares, remove the OAuth section from `zrok-frontend-config.yml.envsubst`.

For this plan, keep the deployment minimal and remove that section.

## Step 8. Adapt the zrok Compose project for Dokploy networking

Your zrok services must be reachable from Dokploy Traefik on `dokploy-network`.

Update the zrok Compose project so that:

1. `zrok-controller` joins `dokploy-network`
2. `zrok-frontend` joins `dokploy-network`
3. `ziti-quickstart` can stay on the zrok internal network, but it must still publish `1443` and `3022`
4. the stack keeps its internal `zrok-instance` network for service-to-service communication

Conceptually, the network section should end up looking like this:

```yaml
networks:
  zrok-instance:
    driver: bridge
  dokploy-network:
    external: true
```

And the controller/frontend services should each attach to both networks.

## Step 9. Add Dokploy Traefik routing labels

Use manual Traefik labels for the zrok services instead of the Dokploy Domains UI, because the frontend needs a wildcard host rule.

### Controller route

Route `zrok.example.com` to `zrok-controller` on port `18080`.

Example labels on `zrok-controller`:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.zrok-controller.rule=Host(`zrok.example.com`)
  - traefik.http.routers.zrok-controller.entrypoints=websecure
  - traefik.http.routers.zrok-controller.tls=true
  - traefik.http.services.zrok-controller.loadbalancer.server.port=18080
```

### Frontend wildcard route

Route dynamic share hosts like `abc123.zrok.example.com` to `zrok-frontend` on port `443`.

Example labels on `zrok-frontend`:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.zrok-frontend.rule=HostRegexp(`{share:[A-Za-z0-9-]+}.zrok.example.com`)
  - traefik.http.routers.zrok-frontend.entrypoints=websecure
  - traefik.http.routers.zrok-frontend.tls=true
  - traefik.http.services.zrok-frontend.loadbalancer.server.port=443
```

This is the key Dokploy-specific change that replaces zrok's separate Traefik deployment.

## Step 10. Deploy the zrok stack in Dokploy

In Dokploy:

1. create a new Docker Compose application
2. name it `zrok-instance`
3. paste the adapted Compose project
4. add the environment variables from your `.env`
5. deploy the application

After deploy, confirm the services are healthy.

## Step 11. Create the first zrok account

Once `zrok-controller` is running, create the first zrok account inside the controller container.

Using the official Docker guide pattern, the command is:

```bash
docker exec -it <zrok-controller-container> bash -xc 'zrok admin create account ${ZROK_USER_EMAIL} ${ZROK_USER_PWD}'
```

Save the returned account token. That token is used by `zrok enable` on client machines.

## Step 12. Enable a zrok client environment

On a client machine with the zrok CLI installed:

```bash
zrok config set apiEndpoint https://zrok.example.com
zrok enable <ACCOUNT_TOKEN>
```

Verify:

```bash
zrok status
```

## Step 13. Test a public share

Create a public share from a client machine and confirm it lands under your wildcard domain.

Expected result:

- the API endpoint is `https://zrok.example.com`
- public share URLs resolve under `https://<share>.zrok.example.com`
- TLS is served by Dokploy Traefik

---

# Validation checklist

## Dokploy

- `https://dokploy.example.com` opens the Dokploy panel
- the Dokploy CLI authenticates successfully with `dokploy verify`

## DNS

```bash
dig +short dokploy.example.com
dig +short zrok.example.com
dig +short test.zrok.example.com
```

All should resolve to your VPS IP.

## zrok routes

```bash
curl -I https://zrok.example.com
curl -I https://test.zrok.example.com
```

Expected:

- successful TLS handshake from Dokploy Traefik
- controller hostname answers on `zrok.example.com`
- wildcard frontend route answers on `*.zrok.example.com`

## OpenZiti ports

From another machine, confirm the server is listening on the published OpenZiti ports:

```bash
nc -vz ziti.zrok.example.com 1443
nc -vz ziti.zrok.example.com 3022
```

## zrok functionality

- `zrok enable <ACCOUNT_TOKEN>` succeeds on a client
- creating a public share returns a hostname under your domain
- that hostname loads through `https://<share>.zrok.example.com`

---

# Troubleshooting

## 1. Dokploy works, but `zrok.example.com` returns 502

Most likely causes:

- `zrok-controller` is not attached to `dokploy-network`
- the Traefik label port does not match the actual controller port
- the zrok stack failed to start

Checks:

```bash
docker ps
docker logs <zrok-controller-container>
docker logs dokploy-traefik
```

## 2. Share URLs do not resolve under your domain

Most likely causes:

- wildcard DNS for `*.zrok.example.com` is missing
- the frontend wildcard Traefik rule is wrong
- `ZROK_DNS_ZONE` is not set to your real zrok zone

## 3. zrok account creation fails

Most likely causes:

- `zrok-controller` is not healthy yet
- `ZROK_ADMIN_TOKEN` is inconsistent across the stack
- the controller bootstrap did not complete

Inspect:

```bash
docker logs <zrok-controller-container>
```

## 4. Clients cannot connect reliably

Most likely causes:

- `1443/tcp` or `3022/tcp` is blocked by a firewall
- `ZITI_CTRL_ADVERTISED_PORT` does not match the exposed port
- your VPS provider blocks uncommon inbound ports

## 5. Dokploy CLI cannot authenticate

Remember the CLI is not the bootstrap path.

Checks:

- the initial admin user must already exist in the UI
- use the correct Dokploy URL
- use a valid API token from the Dokploy panel

---

# Operational notes

## Keep the responsibility split clear

- Dokploy owns the HTTP/TLS edge and app lifecycle
- zrok owns the sharing system and wildcard share naming
- OpenZiti owns the secure backhaul for zrok

## Backups

Back up:

- Dokploy data and `/etc/dokploy`
- zrok volumes and configuration
- any customized zrok Compose files and `.env`

---

# Sources

## Dokploy

- Installation: <https://docs.dokploy.com/docs/core/installation>
- Manual installation: <https://docs.dokploy.com/docs/core/manual-installation>
- Architecture: <https://docs.dokploy.com/docs/core/architecture>

## Dokploy CLI

- Repository: <https://github.com/Dokploy/cli>

## zrok

- Self-hosting guide for Docker: <https://netfoundry.io/docs/zrok/self-hosting/deployment/docker>
- Self-hosting guide for Linux: <https://netfoundry.io/docs/zrok/self-hosting/deployment/linux/>

## Traefik

- Router rules / HostRegexp: <https://doc.traefik.io/traefik/routing/routers/>
