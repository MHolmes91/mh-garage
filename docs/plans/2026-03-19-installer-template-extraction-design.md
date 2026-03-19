# Installer Template Extraction Design

## Goal

Move installer-generated env and Docker Compose file bodies out of JavaScript string builders and into checked-in template files so they are easier to inspect, edit, and keep aligned with the generated artifacts.

## Scope

- Extract the generated zrok `.env` content into a real template file.
- Extract the generated `compose.dokploy.yml` content into a real template file.
- Extract the generated `zrok-frontend-config.yml.envsubst` content into a real template file.
- Update the Node installer to render those templates with explicit `${VAR}` substitution.
- Preserve the current generated output shape and installer behavior.

## Recommended Approach

Store literal-ish template files under `scripts/templates/` and render them through one small helper in `scripts/lib.mjs`. The templates should stay mostly human-readable and mostly valid as their target file formats, with only the dynamic values expressed as `${VAR}` placeholders.

This keeps the installer logic small and moves the file content into the filesystem where it belongs. It also makes future edits to env or Compose structure much easier than changing multiline JavaScript string builders.

## Template Model

Templates should be plain text files committed to the repo:

- `scripts/templates/zrok-frontend-config.yml.envsubst`
- `scripts/templates/zrok.env`
- `scripts/templates/compose.dokploy.yml`

Each file uses `${VAR}` placeholders. The installer reads the template, substitutes values from an explicit variable map, and writes the rendered output to the instance directory.

## Rendering Rules

- Substitution should be explicit, not `eval`-like.
- Missing variables should throw an error immediately.
- Unused variables in the input map are acceptable.
- No extra templating language is needed beyond `${VAR}` replacement.
- Output should preserve current newline/content shape so existing tests and Dokploy behavior remain stable.

## Installer Changes

The current `writeInstallerArtifacts()` flow in `scripts/install.js` should stay in place, but instead of calling inline builder functions, it should:

1. load template files
2. render them with the current env snapshot
3. write the rendered results to the zrok instance directory

The Compose API helper does not need direct changes beyond continuing to consume the generated files.

## Shared Helper Changes

Add a small shared template layer in `scripts/lib.mjs`:

- `renderTemplate(templateText, variables)`
- `readTemplate(templatePath)` or a convenience helper that reads then renders

The helper should be generic enough for the three installer artifacts, but not more abstract than necessary.

## Testing Strategy

Use TDD for the extraction:

- add a failing unit test for `${VAR}` substitution
- add a failing unit test for missing-variable failure
- add/adjust installer tests to confirm the generated files still contain the expected rendered output
- add a small test proving the renderer reads from checked-in template files, not inline JS builders

## Success Criteria

- `scripts/install.js` no longer hardcodes the zrok env, frontend config, or Dokploy Compose file bodies.
- Template files under `scripts/templates/` are the source of truth.
- Installer output remains compatible with current tests and deployment flow.
- Missing template variables fail fast with a readable error.
