#!/usr/bin/env bash

log() {
	printf '\n==> %s\n' "$1"
}

note() {
	printf ' -> %s\n' "$1"
}

quote_env_value() {
	local value="$1"
	value=${value//\'/\'"\'"\'}
	printf "'%s'" "$value"
}

upsert_env() {
	local key="$1"
	local value="$2"
	local quoted tmp found line
	quoted=$(quote_env_value "$value")
	tmp=$(mktemp)
	found=0

	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ "$line" == "$key="* ]]; then
			printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
			found=1
		else
			printf '%s\n' "$line" >>"$tmp"
		fi
	done <"$ENV_FILE"

	if [[ "$found" -eq 0 ]]; then
		printf '%s=%s\n' "$key" "$quoted" >>"$tmp"
	fi

	mv "$tmp" "$ENV_FILE"
}

set_var() {
	local key="$1"
	local value="$2"
	printf -v "$key" '%s' "$value"
	export "$key"
	upsert_env "$key" "$value"
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

require_command() {
	local cmd="$1"
	if ! command_exists "$cmd"; then
		printf 'Required command not found: %s\n' "$cmd" >&2
		exit 1
	fi
}
