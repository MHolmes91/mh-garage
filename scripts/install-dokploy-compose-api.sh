#!/usr/bin/env bash

set -euo pipefail

source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE="pause"
ENV_FILE=".env"
PREPARED="false"

usage() {
  cat <<'EOF'
Usage: install-dokploy-compose-api.sh [--env-file PATH] [--mode pause|exit] [--prepared]

This experimental helper installs zrok as a Dokploy-managed Docker Compose app
via Dokploy HTTP APIs. It is intended to be called by scripts/install.sh after
shared Dokploy/zrok preparation is complete.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
  --env-file)
    ENV_FILE="$2"
    shift 2
    ;;
  --mode)
    MODE="$2"
    shift 2
    ;;
  --prepared)
    PREPARED="true"
    shift
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

if [[ "$MODE" != "pause" && "$MODE" != "exit" ]]; then
  printf 'Invalid mode: %s\n' "$MODE" >&2
  exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

set -a
source "$ENV_FILE"
set +a

json_eval() {
  local script="$1"
  shift
  node -e "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { const input = JSON.parse(data); ${script} });" "$@"
}

json_quote() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

trpc_get() {
  local endpoint="$1"
  local input_json="${2-}"
  local url="$DOKPLOY_URL/api/trpc/$endpoint"
  if [[ -n "$input_json" ]]; then
    curl -fsS -G "$url" \
      -H "x-api-key: $DOKPLOY_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data-urlencode "input={\"json\":$input_json}"
  else
    curl -fsS "$url" \
      -H "x-api-key: $DOKPLOY_API_TOKEN" \
      -H "Content-Type: application/json"
  fi
}

trpc_post() {
  local endpoint="$1"
  local payload_json="$2"
  local url="$DOKPLOY_URL/api/trpc/$endpoint"
  curl -fsS "$url" \
    -X POST \
    -H "x-api-key: $DOKPLOY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"json\":$payload_json}"
}

project_id_by_name() {
  local name="$1"
  trpc_get "project.all" | json_eval '
		const projects = input.result.data.json || [];
		const match = projects.find((p) => p.name === process.argv[1]);
		process.stdout.write(match?.projectId || "");
	' "$name"
}

environment_id_by_name() {
  local project_id="$1"
  local name="$2"
  trpc_get "project.one" "{\"projectId\":$(json_quote "$project_id")}" | json_eval '
		const project = input.result.data.json || {};
		const envs = project.environments || [];
		const match = envs.find((e) => e.name === process.argv[1]);
		process.stdout.write(match?.environmentId || "");
	' "$name"
}

compose_id_in_environment() {
  local project_id="$1"
  local environment_name="$2"
  local compose_name="$3"
  local compose_app_name="$4"
  trpc_get "project.one" "{\"projectId\":$(json_quote "$project_id")}" | json_eval '
		const project = input.result.data.json || {};
		const envs = project.environments || [];
		const env = envs.find((e) => e.name === process.argv[1]);
		const services = env?.compose || [];
		const match = services.find((c) => c.name === process.argv[2] || c.appName === process.argv[3]);
		process.stdout.write(match?.composeId || "");
	' "$environment_name" "$compose_name" "$compose_app_name"
}

create_project() {
  local payload response
  payload=$(node -e 'process.stdout.write(JSON.stringify({ name: process.argv[1], description: process.argv[2] }))' "$DOKPLOY_PROJECT_NAME" "$DOKPLOY_PROJECT_DESCRIPTION")
  response=$(trpc_post "project.create" "$payload")
  printf '%s' "$response" | json_eval 'process.stdout.write(input.result.data.json.projectId || "");'
}

create_environment() {
  local payload response
  payload=$(node -e 'process.stdout.write(JSON.stringify({ name: process.argv[1], description: process.argv[2], projectId: process.argv[3] }))' "$DOKPLOY_ENVIRONMENT_NAME" "$DOKPLOY_ENVIRONMENT_DESCRIPTION" "$DOKPLOY_PROJECT_ID")
  response=$(trpc_post "environment.create" "$payload")
  printf '%s' "$response" | json_eval 'process.stdout.write(input.result.data.json.environmentId || "");'
}

create_compose() {
  local payload response
  payload=$(node -e 'process.stdout.write(JSON.stringify({ name: process.argv[1], description: process.argv[2], environmentId: process.argv[3], composeType: "docker-compose", appName: process.argv[4] }))' "$DOKPLOY_COMPOSE_NAME" "$DOKPLOY_COMPOSE_DESCRIPTION" "$DOKPLOY_ENVIRONMENT_ID" "$DOKPLOY_COMPOSE_APP_NAME")
  response=$(trpc_post "compose.create" "$payload")
  printf '%s' "$response" | json_eval 'process.stdout.write(input.result.data.json.composeId || "");'
}

update_compose() {
  local compose_yaml compose_env payload
  compose_yaml=$(cd "$ZROK_INSTANCE_DIR" && docker compose -f compose.yml -f compose.dokploy.yml config)
  compose_env=$(<"$ZROK_INSTANCE_DIR/.env")
  payload=$(node -e 'process.stdout.write(JSON.stringify({ composeId: process.argv[1], sourceType: "raw", composePath: "./docker-compose.yml", composeFile: process.argv[2], env: process.argv[3], name: process.argv[4], description: process.argv[5] }))' "$DOKPLOY_COMPOSE_ID" "$compose_yaml" "$compose_env" "$DOKPLOY_COMPOSE_NAME" "$DOKPLOY_COMPOSE_DESCRIPTION")
  trpc_post "compose.update" "$payload" >/dev/null
}

deploy_compose() {
  local payload
  payload=$(node -e 'process.stdout.write(JSON.stringify({ composeId: process.argv[1], title: "Install self-hosted zrok", description: "Automated zrok compose deployment" }))' "$DOKPLOY_COMPOSE_ID")
  trpc_post "compose.deploy" "$payload" >/dev/null
}

require_command curl
require_command docker
require_command node

set_var "DOKPLOY_PROJECT_NAME" "${DOKPLOY_PROJECT_NAME:-zrok}"
set_var "DOKPLOY_PROJECT_DESCRIPTION" "${DOKPLOY_PROJECT_DESCRIPTION:-Self-hosted zrok services}"
set_var "DOKPLOY_ENVIRONMENT_NAME" "${DOKPLOY_ENVIRONMENT_NAME:-production}"
set_var "DOKPLOY_ENVIRONMENT_DESCRIPTION" "${DOKPLOY_ENVIRONMENT_DESCRIPTION:-Production services}"
set_var "DOKPLOY_COMPOSE_NAME" "${DOKPLOY_COMPOSE_NAME:-zrok-instance}"
set_var "DOKPLOY_COMPOSE_DESCRIPTION" "${DOKPLOY_COMPOSE_DESCRIPTION:-Self-hosted zrok on Dokploy}"
set_var "DOKPLOY_COMPOSE_APP_NAME" "${DOKPLOY_COMPOSE_APP_NAME:-zrok-instance}"

if [[ "$PREPARED" != "true" ]]; then
  printf 'This helper expects prepared artifacts. Run scripts/install.sh with --deploy-method dokploy-compose-api instead.\n' >&2
  exit 1
fi

if [[ -z "${DOKPLOY_API_TOKEN:-}" ]]; then
  printf 'DOKPLOY_API_TOKEN is required for the Dokploy Compose API installer.\n' >&2
  exit 1
fi

if [[ -z "${DOKPLOY_PROJECT_ID:-}" ]]; then
  DOKPLOY_PROJECT_ID=$(project_id_by_name "$DOKPLOY_PROJECT_NAME")
  if [[ -z "$DOKPLOY_PROJECT_ID" ]]; then
    log "Creating Dokploy project"
    DOKPLOY_PROJECT_ID=$(create_project)
  fi
  set_var "DOKPLOY_PROJECT_ID" "$DOKPLOY_PROJECT_ID"
fi

if [[ -z "${DOKPLOY_ENVIRONMENT_ID:-}" ]]; then
  DOKPLOY_ENVIRONMENT_ID=$(environment_id_by_name "$DOKPLOY_PROJECT_ID" "$DOKPLOY_ENVIRONMENT_NAME")
  if [[ -z "$DOKPLOY_ENVIRONMENT_ID" ]]; then
    log "Creating Dokploy environment"
    DOKPLOY_ENVIRONMENT_ID=$(create_environment)
  fi
  set_var "DOKPLOY_ENVIRONMENT_ID" "$DOKPLOY_ENVIRONMENT_ID"
fi

if [[ -z "${DOKPLOY_COMPOSE_ID:-}" ]]; then
  DOKPLOY_COMPOSE_ID=$(compose_id_in_environment "$DOKPLOY_PROJECT_ID" "$DOKPLOY_ENVIRONMENT_NAME" "$DOKPLOY_COMPOSE_NAME" "$DOKPLOY_COMPOSE_APP_NAME")
  if [[ -z "$DOKPLOY_COMPOSE_ID" ]]; then
    log "Creating Dokploy compose app"
    DOKPLOY_COMPOSE_ID=$(create_compose)
  fi
  set_var "DOKPLOY_COMPOSE_ID" "$DOKPLOY_COMPOSE_ID"
fi

log "Updating Dokploy compose app with rendered zrok config"
update_compose

log "Deploying Dokploy compose app"
deploy_compose
