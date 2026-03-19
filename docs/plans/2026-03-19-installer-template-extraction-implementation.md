# Installer Template Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move installer-generated env and Docker Compose file bodies into checked-in template files and have the Node installer render them with explicit `${VAR}` substitution.

**Architecture:** Add plain-text templates under `scripts/templates/`, then replace inline string builders in `scripts/lib.mjs`/`scripts/install.js` with a tiny renderer that reads a template, substitutes required variables, and writes the rendered artifact. Keep the current installer flow and output shape intact so the Compose API helper and existing deployment logic keep working.

**Tech Stack:** Node 18+, ES modules, built-in `node:test`, `fs/promises`, `path`

---

### Task 1: Add failing tests for template rendering

**Files:**
- Modify: `scripts/install.test.mjs`

**Step 1: Write the failing test**

Add tests for a future `renderTemplate()` helper.

```js
test('renderTemplate substitutes ${VAR} placeholders', async () => {
  const { renderTemplate } = await import('./lib.mjs');
  assert.equal(
    renderTemplate('hello ${NAME}', { NAME: 'world' }),
    'hello world',
  );
});

test('renderTemplate throws for missing variables', async () => {
  const { renderTemplate } = await import('./lib.mjs');
  assert.throws(() => renderTemplate('hello ${NAME}', {}), /Missing template variable: NAME/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL because `renderTemplate` does not exist yet

**Step 3: Write minimal implementation**

Do not implement all file loading yet. Only add the smallest `renderTemplate(templateText, variables)` helper in `scripts/lib.mjs` needed to satisfy the tests.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS for the new renderer tests

### Task 2: Add checked-in template files

**Files:**
- Create: `scripts/templates/zrok-frontend-config.yml.envsubst`
- Create: `scripts/templates/zrok.env`
- Create: `scripts/templates/compose.dokploy.yml`
- Modify: `scripts/install.test.mjs`

**Step 1: Write the failing test**

Add a test that reads the future template files and asserts they contain the expected `${VAR}` placeholders.

```js
test('installer templates exist with expected placeholders', async () => {
  const frontendTemplate = await readFile('scripts/templates/zrok-frontend-config.yml.envsubst', 'utf8');
  assert.match(frontendTemplate, /\$\{ZROK_DNS_ZONE\}/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL because the template files do not exist yet

**Step 3: Write minimal implementation**

Create the three template files using the current literal content shape, but replace dynamic values with `${VAR}` placeholders.

Example `scripts/templates/zrok.env`:

```dotenv
ZROK_DNS_ZONE=${ZROK_DOMAIN}
ZROK_USER_EMAIL=${ZROK_USER_EMAIL}
ZROK_USER_PWD=${ZROK_USER_PWD}
```

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS for the template existence/placeholder test

### Task 3: Replace inline artifact builders with template rendering

**Files:**
- Modify: `scripts/lib.mjs`
- Modify: `scripts/install.js`
- Modify: `scripts/install.test.mjs`

**Step 1: Write the failing test**

Add or update the installer artifact test so it checks the renderer-backed output still matches the expected generated files.

```js
test('install cli writes artifacts from template files', async () => {
  const { main } = await import('./install.js');
  // run installer with mocked dependencies, then assert rendered files contain concrete values
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL because the installer still uses inline builders or does not load templates yet

**Step 3: Write minimal implementation**

In `scripts/lib.mjs`, add a helper that reads a template file and renders it. In `scripts/install.js`, update `writeInstallerArtifacts()` to use the template files instead of inline content builders.

Suggested helpers:

```js
export function renderTemplate(templateText, variables) { ... }
export async function renderTemplateFile(templatePath, variables) { ... }
```

Map only the variables each template actually needs.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS with rendered artifact assertions still green

### Task 4: Remove obsolete inline builders and verify the full suite

**Files:**
- Modify: `scripts/lib.mjs`
- Modify: `scripts/install.test.mjs`

**Step 1: Write the failing test**

Add a small regression test asserting a missing placeholder variable fails with a readable error from the template-file path.

```js
test('renderTemplateFile fails fast for missing template variables', async () => {
  await assert.rejects(
    renderTemplateFile('scripts/templates/zrok.env', {}),
    /Missing template variable:/,
  );
});
```

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL until the file-backed renderer is complete

**Step 3: Write minimal implementation**

Remove any now-unused inline builder helpers from `scripts/lib.mjs` and keep only the file-backed rendering path.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS

### Task 5: Final verification

**Files:**
- Modify: `scripts/install.test.mjs`
- Modify: `scripts/install.js`
- Modify: `scripts/lib.mjs`

**Step 1: Run targeted tests**

Run: `node --test scripts/install.test.mjs`
Expected: PASS with no warnings

**Step 2: Run full package tests**

Run: `npm test`
Expected: PASS

**Step 3: Run CLI smoke checks**

Run: `npm run install:host -- --help`
Expected: help output prints and exits 0

Run: `npm run install:dokploy-compose-api -- --help`
Expected: help output prints and exits 0

**Step 4: Prepare commit**

```bash
git add scripts/templates scripts/install.js scripts/lib.mjs scripts/install.test.mjs docs/plans/2026-03-19-installer-template-extraction-design.md docs/plans/2026-03-19-installer-template-extraction-implementation.md
git commit -m "refactor: move installer artifacts into templates"
```
