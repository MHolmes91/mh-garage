# Remove Dokploy CLI Node Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the redundant `ensureNodeForDokployCli` gate from the Node installer while preserving Dokploy CLI install/auth behavior.

**Architecture:** Since the installer already runs under Node, it should not separately prove that Node exists before attempting Dokploy CLI installation. The installer will keep the `dokploy` existence check and let the actual `npm`/`dokploy` subprocesses be the source of truth.

**Tech Stack:** Node 18+, ES modules, `node:test`

---

### Task 1: Remove the redundant gate with TDD

**Files:**
- Modify: `scripts/install.js`
- Modify: `scripts/install.test.mjs`
- Modify: `scripts/lib.mjs`

**Step 1: Write the failing test**

Add/update tests to prove the installer no longer depends on `ensureNodeForDokployCli` and still:
- installs `dokploy` only when missing
- skips install when `dokploy` already exists

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL because the installer still calls the removed gate or the old unit test still exists

**Step 3: Write minimal implementation**

- Remove the `ensureNodeForDokployCli` call from `scripts/install.js`
- Remove the now-unused helper from `scripts/lib.mjs`
- Replace old unit coverage with installer-level behavior coverage in `scripts/install.test.mjs`

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS

### Task 2: Verify the package

**Files:**
- Modify: `scripts/install.test.mjs`

**Step 1: Run full suite**

Run: `npm test`
Expected: PASS

**Step 2: Run CLI smoke checks**

Run: `npm run install:host -- --help`
Expected: PASS

Run: `npm run install:dokploy-compose-api -- --help`
Expected: PASS
