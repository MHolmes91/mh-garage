#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$SCRIPT_DIR/lib.sh"

MODE="pause"
CLI_MODE=""
ENV_FILE=".env"
DEPLOY_METHOD="raw"
CLI_DEPLOY_METHOD=""

usage() {
  cat <<'EOF'
Usage: install.sh [--env-file PATH] [--mode pause|exit] [--deploy-method raw|dokploy-compose-api]

Options:
  --env-file PATH   Load and persist variables in this env file
  --mode MODE       pause (default) or exit when manual input is needed
  --deploy-method   raw (default) or dokploy-compose-api
  --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --env-file)
    ENV_FILE="$2"
    shift 2
    ;;
  --mode)
    CLI_MODE="$2"
    shift 2
    ;;
  --deploy-method)
    CLI_DEPLOY_METHOD="$2"
    shift 2
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    printf 'Unknown argument: %s\n' "$1" >&2
    usage >&2
    exit 1
    ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'This script must run as root.\n' >&2
  exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  printf 'This script only supports Linux hosts.\n' >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

set -a
source "$ENV_FILE"
set +a

if [[ -n "$CLI_MODE" ]]; then
  MODE="$CLI_MODE"
fi

if [[ -n "$CLI_DEPLOY_METHOD" ]]; then
  DEPLOY_METHOD="$CLI_DEPLOY_METHOD"
fi

if [[ "$MODE" != "pause" && "$MODE" != "exit" ]]; then
  printf 'Invalid mode: %s\n' "$MODE" >&2
  exit 1
fi

if [[ "$DEPLOY_METHOD" != "raw" && "$DEPLOY_METHOD" != "dokploy-compose-api" ]]; then
  printf 'Invalid deploy method: %s\n' "$DEPLOY_METHOD" >&2
  exit 1
fi

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40
  else
    date +%s | sha256sum | cut -c1-40
  fi
}

prompt_value() {
  local key="$1"
  local prompt="$2"
  local default_value="${3-}"
  local secret="${4-false}"
  local value="${!key-}"

  if [[ -n "$value" ]]; then
    return 0
  fi

  if [[ "$MODE" == "exit" ]]; then
    printf '\nManual input required for %s. Add it to %s and rerun.\n' "$key" "$ENV_FILE"
    exit 0
  fi

  while true; do
    if [[ "$secret" == "true" ]]; then
      if [[ -n "$default_value" ]]; then
        printf '%s [%s]: ' "$prompt" "$default_value"
      else
        printf '%s: ' "$prompt"
      fi
      read -r -s value
      printf '\n'
    else
      if [[ -n "$default_value" ]]; then
        printf '%s [%s]: ' "$prompt" "$default_value"
      else
        printf '%s: ' "$prompt"
      fi
      read -r value
    fi

    if [[ -z "$value" && -n "$default_value" ]]; then
      value="$default_value"
    fi

    if [[ -n "$value" ]]; then
      set_var "$key" "$value"
      break
    fi
  done
}

pause_or_exit() {
  local message="$1"
  printf '\n%s\n' "$message"
  if [[ "$MODE" == "pause" ]]; then
    printf 'Press Enter once this is done to continue. '
    read -r _
  else
    printf 'Exiting now. Rerun the script after finishing that step.\n'
    exit 0
  fi
}

https_ok() {
  local url="$1"
  curl -fsSIL "$url" >/dev/null 2>&1
}

ensure_nodejs() {
  if ! command_exists node || ! command_exists npm; then
    printf 'Node.js 18+ and npm are required for the Dokploy CLI. Install them first, then rerun.\n' >&2
    exit 1
  fi

  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
    printf 'Node.js 18+ is required for the Dokploy CLI. Upgrade Node.js, then rerun.\n' >&2
    exit 1
  fi
}

get_public_ip() {
  local ip=""
  ip=$(curl -4fsS --connect-timeout 5 https://ifconfig.io 2>/dev/null || true)
  if [[ -z "$ip" ]]; then
    ip=$(curl -4fsS --connect-timeout 5 https://icanhazip.com 2>/dev/null || true)
  fi
  if [[ -z "$ip" ]]; then
    ip=$(curl -4fsS --connect-timeout 5 https://ipecho.net/plain 2>/dev/null || true)
  fi
  printf '%s' "${ip//$'\n'/}"
}

host_resolves_to() {
  local host="$1"
  local expected_ip="$2"
  local output=""
  output=$(getent ahostsv4 "$host" 2>/dev/null || true)
  [[ -n "$output" ]] || return 1
  while IFS=' ' read -r ip _; do
    [[ -n "$ip" ]] || continue
    if [[ "$ip" == "$expected_ip" ]]; then
      return 0
    fi
  done <<<"$output"
  return 1
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-60}"
  local sleep_seconds="${3:-2}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

ensure_dokploy_installed() {
  if docker service inspect dokploy >/dev/null 2>&1; then
    note "Dokploy service already exists"
    return 0
  fi

  log "Installing Dokploy"
  export DOKPLOY_VERSION="${DOKPLOY_VERSION:-latest}"
  if [[ -n "${ADVERTISE_ADDR:-}" ]]; then
    export ADVERTISE_ADDR
  fi
  if [[ -n "${DOCKER_SWARM_INIT_ARGS:-}" ]]; then
    export DOCKER_SWARM_INIT_ARGS
  fi
  curl -sSL https://dokploy.com/install.sh | sh
}

wait_for_dokploy() {
  log "Waiting for Dokploy panel"
  if wait_for_http "http://127.0.0.1:3000" 90 2; then
    note "Dokploy is reachable on http://127.0.0.1:3000"
    return 0
  fi
  printf 'Dokploy did not become reachable on port 3000 in time.\n' >&2
  exit 1
}

ensure_dokploy_cli() {
  if command_exists dokploy; then
    note "Dokploy CLI already installed"
    return 0
  fi
  log "Installing Dokploy CLI"
  npm install -g @dokploy/cli
}

authenticate_dokploy_cli() {
  log "Authenticating Dokploy CLI"
  dokploy authenticate -u "$DOKPLOY_URL" -t "$DOKPLOY_API_TOKEN"
}

ensure_zrok_project() {
  if [[ -f "$ZROK_INSTANCE_DIR/compose.yml" ]]; then
    note "zrok instance project already exists at $ZROK_INSTANCE_DIR"
    return 0
  fi

  log "Fetching the official zrok instance project"
  mkdir -p "$ZROK_INSTANCE_DIR"
  (cd "$ZROK_INSTANCE_DIR" && curl -fsSL https://get.openziti.io/zrok-instance/fetch.bash | bash)
}

write_zrok_frontend_config() {
  log "Writing minimal zrok frontend config template"
  cat >"$ZROK_INSTANCE_DIR/zrok-frontend-config.yml.envsubst" <<'EOF'
v: 4

host_match: ${ZROK_DNS_ZONE}
address: 0.0.0.0:${ZROK_FRONTEND_PORT}
EOF
}

write_zrok_env() {
  log "Writing zrok project env file"
  cat >"$ZROK_INSTANCE_DIR/.env" <<EOF
ZROK_DNS_ZONE=$ZROK_DOMAIN
ZROK_USER_EMAIL=$ZROK_USER_EMAIL
ZROK_USER_PWD=$ZROK_USER_PWD
ZROK_ADMIN_TOKEN=$ZROK_ADMIN_TOKEN
ZITI_PWD=$ZITI_PWD
ZROK_CTRL_PORT=$ZROK_CTRL_PORT
ZROK_FRONTEND_PORT=$ZROK_FRONTEND_INTERNAL_PORT
ZROK_OAUTH_PORT=$ZROK_OAUTH_PORT
ZITI_CTRL_ADVERTISED_PORT=$ZITI_CTRL_ADVERTISED_PORT
ZITI_ROUTER_PORT=$ZITI_ROUTER_PORT
ZROK_INSECURE_INTERFACE=127.0.0.1
ZITI_INTERFACE=0.0.0.0
EOF
}

write_dokploy_override() {
  log "Writing Dokploy Traefik override compose file"
  cat >"$ZROK_INSTANCE_DIR/compose.dokploy.yml" <<EOF
services:
  zrok-controller:
    networks:
      - zrok-instance
      - dokploy-network
    labels:
      - traefik.enable=true
      - 'traefik.http.routers.zrok-controller-web.rule=Host("$ZROK_DOMAIN")'
      - traefik.http.routers.zrok-controller-web.entrypoints=web
      - traefik.http.routers.zrok-controller-web.middlewares=redirect-to-https@file
      - traefik.http.routers.zrok-controller-web.service=zrok-controller
      - 'traefik.http.routers.zrok-controller-websecure.rule=Host("$ZROK_DOMAIN")'
      - traefik.http.routers.zrok-controller-websecure.entrypoints=websecure
      - traefik.http.routers.zrok-controller-websecure.tls=true
      - traefik.http.routers.zrok-controller-websecure.tls.certresolver=$TRAEFIK_CERT_RESOLVER
      - traefik.http.routers.zrok-controller-websecure.service=zrok-controller
      - traefik.http.services.zrok-controller.loadbalancer.server.port=$ZROK_CTRL_PORT

  zrok-frontend:
    networks:
      - zrok-instance
      - dokploy-network
    environment:
      ZROK_FRONTEND_SCHEME: https
      ZROK_FRONTEND_PORT: "$ZROK_PUBLIC_HTTPS_PORT"
    labels:
      - traefik.enable=true
      - 'traefik.http.routers.zrok-frontend-web.rule=HostRegexp("{share:[A-Za-z0-9-]+}.$ZROK_DOMAIN")'
      - traefik.http.routers.zrok-frontend-web.entrypoints=web
      - traefik.http.routers.zrok-frontend-web.middlewares=redirect-to-https@file
      - traefik.http.routers.zrok-frontend-web.service=zrok-frontend
      - 'traefik.http.routers.zrok-frontend-websecure.rule=HostRegexp("{share:[A-Za-z0-9-]+}.$ZROK_DOMAIN")'
      - traefik.http.routers.zrok-frontend-websecure.entrypoints=websecure
      - traefik.http.routers.zrok-frontend-websecure.tls=true
      - traefik.http.routers.zrok-frontend-websecure.tls.certresolver=$TRAEFIK_CERT_RESOLVER
      - traefik.http.routers.zrok-frontend-websecure.service=zrok-frontend
      - traefik.http.services.zrok-frontend.loadbalancer.server.port=$ZROK_FRONTEND_INTERNAL_PORT

networks:
  dokploy-network:
    external: true
EOF
}

deploy_zrok_stack() {
  log "Deploying the zrok stack"
  docker network inspect dokploy-network >/dev/null 2>&1
  (
    cd "$ZROK_INSTANCE_DIR"
    docker compose -f compose.yml -f compose.dokploy.yml up -d --build
  )
}

create_zrok_account() {
  local state_dir token_file output token container_id
  state_dir="$ZROK_INSTANCE_DIR/.installer-state"
  token_file="$state_dir/zrok-account-token"
  mkdir -p "$state_dir"
  chmod 700 "$state_dir"

  if [[ -n "${ZROK_ACCOUNT_TOKEN:-}" ]]; then
    printf '%s\n' "$ZROK_ACCOUNT_TOKEN" >"$token_file"
    chmod 600 "$token_file"
    note "Using existing zrok account token from env file"
    return 0
  fi

  if [[ -s "$token_file" ]]; then
    note "zrok account token already saved in $token_file"
    return 0
  fi

  pause_or_exit "Next manual checkpoint: the script is ready to create the first zrok account using $ZROK_USER_EMAIL. If you want to change the email or password, edit $ENV_FILE now."

  log "Creating the first zrok account"
  if [[ "$DEPLOY_METHOD" == "dokploy-compose-api" ]]; then
    container_id=$(docker ps -q \
      --filter "label=com.docker.compose.project=$DOKPLOY_COMPOSE_APP_NAME" \
      --filter "label=com.docker.compose.service=zrok-controller" | head -n 1)
    if [[ -z "$container_id" ]]; then
      printf 'Could not find the Dokploy-managed zrok controller container.\n' >&2
      exit 1
    fi
    output=$(docker exec "$container_id" bash -lc 'zrok admin create account "$ZROK_USER_EMAIL" "$ZROK_USER_PWD"')
  else
    output=$(
      cd "$ZROK_INSTANCE_DIR"
      docker compose exec -T zrok-controller bash -lc 'zrok admin create account "$ZROK_USER_EMAIL" "$ZROK_USER_PWD"'
    )
  fi
  token=$(printf '%s\n' "$output" | sed '/^$/d' | tail -n 1)
  if [[ -z "$token" ]]; then
    printf 'Failed to capture the zrok account token.\n' >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  printf '%s\n' "$token" >"$token_file"
  chmod 600 "$token_file"
  set_var "ZROK_ACCOUNT_TOKEN" "$token"
  note "Saved zrok account token to $token_file"
}

show_summary() {
  local token_file
  token_file="$ZROK_INSTANCE_DIR/.installer-state/zrok-account-token"
  log "Done"
  note "Dokploy panel bootstrap URL: http://127.0.0.1:3000"
  note "Dokploy URL: $DOKPLOY_URL"
  note "zrok controller URL: https://$ZROK_DOMAIN"
  note "Example share URL pattern: https://<share>.$ZROK_DOMAIN"
  if [[ -s "$token_file" ]]; then
    note "zrok account token file: $token_file"
  fi
  printf '\nNext client-side commands:\n'
  printf '  zrok config set apiEndpoint https://%s\n' "$ZROK_DOMAIN"
  printf '  zrok enable <ACCOUNT_TOKEN>\n'
}

set_var "INSTALL_DOKPLOY_CLI" "${INSTALL_DOKPLOY_CLI:-true}"
set_var "DEPLOY_METHOD" "${DEPLOY_METHOD:-raw}"
set_var "ZROK_INSTANCE_DIR" "${ZROK_INSTANCE_DIR:-/opt/zrok-instance}"
set_var "TRAEFIK_CERT_RESOLVER" "${TRAEFIK_CERT_RESOLVER:-letsencrypt}"
set_var "ZROK_CTRL_PORT" "${ZROK_CTRL_PORT:-18080}"
set_var "ZROK_FRONTEND_INTERNAL_PORT" "${ZROK_FRONTEND_INTERNAL_PORT:-8080}"
set_var "ZROK_PUBLIC_HTTPS_PORT" "${ZROK_PUBLIC_HTTPS_PORT:-443}"
set_var "ZROK_OAUTH_PORT" "${ZROK_OAUTH_PORT:-8081}"
set_var "ZITI_CTRL_ADVERTISED_PORT" "${ZITI_CTRL_ADVERTISED_PORT:-1443}"
set_var "ZITI_ROUTER_PORT" "${ZITI_ROUTER_PORT:-3022}"

if [[ -z "${DOKPLOY_DOMAIN:-}" ]]; then
  prompt_value "DOKPLOY_DOMAIN" "Dokploy panel domain" "dokploy.example.com"
fi
if [[ -z "${ZROK_DOMAIN:-}" ]]; then
  prompt_value "ZROK_DOMAIN" "zrok base domain" "zrok.example.com"
fi
if [[ -z "${DOKPLOY_URL:-}" ]]; then
  set_var "DOKPLOY_URL" "https://$DOKPLOY_DOMAIN"
fi

if [[ -z "${ZROK_ADMIN_TOKEN:-}" ]]; then
  set_var "ZROK_ADMIN_TOKEN" "$(random_token)"
fi
if [[ -z "${ZITI_PWD:-}" ]]; then
  set_var "ZITI_PWD" "$(random_token)"
fi

ensure_dokploy_installed
wait_for_dokploy

PUBLIC_IP=$(get_public_ip || true)
if [[ -n "$PUBLIC_IP" ]]; then
  note "Detected public IP: $PUBLIC_IP"
fi

pause_or_exit "Manual checkpoint: open http://${PUBLIC_IP:-127.0.0.1}:3000 (or http://127.0.0.1:3000 locally), create the initial Dokploy admin user, and generate a Dokploy API token."

if [[ -n "$PUBLIC_IP" ]]; then
  if ! host_resolves_to "$DOKPLOY_DOMAIN" "$PUBLIC_IP"; then
    pause_or_exit "Manual checkpoint: point $DOKPLOY_DOMAIN to $PUBLIC_IP and, if desired, configure that domain inside Dokploy before continuing."
  fi
fi

if ! https_ok "$DOKPLOY_URL"; then
  pause_or_exit "Manual checkpoint: configure the Dokploy panel domain and HTTPS in the Dokploy UI, then confirm $DOKPLOY_URL loads successfully over HTTPS before continuing."
  if ! https_ok "$DOKPLOY_URL"; then
    printf 'Dokploy HTTPS check failed for %s. Fix panel HTTPS in the UI, then rerun.\n' "$DOKPLOY_URL" >&2
    exit 1
  fi
fi

if [[ "$INSTALL_DOKPLOY_CLI" == "true" ]]; then
  prompt_value "DOKPLOY_API_TOKEN" "Dokploy API token" "" "true"
  ensure_nodejs
  ensure_dokploy_cli
  authenticate_dokploy_cli
fi

prompt_value "ZROK_USER_EMAIL" "First zrok user email" "admin@example.com"
prompt_value "ZROK_USER_PWD" "First zrok user password" "" "true"

ensure_zrok_project
write_zrok_frontend_config
write_zrok_env
write_dokploy_override

if [[ -n "$PUBLIC_IP" ]]; then
  if ! host_resolves_to "$ZROK_DOMAIN" "$PUBLIC_IP"; then
    pause_or_exit "Manual checkpoint: point $ZROK_DOMAIN to $PUBLIC_IP and create a wildcard DNS record for *.$ZROK_DOMAIN before continuing."
  fi
  if ! host_resolves_to "probe.$ZROK_DOMAIN" "$PUBLIC_IP"; then
    pause_or_exit "Manual checkpoint: wildcard DNS for *.$ZROK_DOMAIN does not resolve to $PUBLIC_IP yet."
  fi
fi

if [[ "$DEPLOY_METHOD" == "dokploy-compose-api" ]]; then
  log "Delegating zrok deployment to Dokploy Compose API helper"
  bash "$SCRIPT_DIR/install-dokploy-compose-api.sh" --env-file "$ENV_FILE" --mode "$MODE" --prepared
else
  deploy_zrok_stack
fi

create_zrok_account
show_summary
