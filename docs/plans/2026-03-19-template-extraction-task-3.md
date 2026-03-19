# Template Extraction Task 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace installer inline artifact builders with renderer-backed template output while preserving the exact generated files.

**Architecture:** Keep the existing builder functions in place for Task 4 cleanup, but add a shared template-rendering helper in `scripts/lib.mjs` that loads checked-in templates and renders them with installer env values. Update `writeInstallerArtifacts()` in `scripts/install.js` to consume that helper, then prove the generated artifacts still contain the concrete values expected by the installer flow.

**Tech Stack:** Node.js ESM, `node:test`, filesystem template loading/rendering

---

### Task 1: Add failing coverage for renderer-backed installer artifacts

**Files:**
- Modify: `scripts/install.test.mjs`
- Modify: `scripts/install.js`
- Modify: `scripts/lib.mjs`

**Step 1: Write the failing test**

Add a test that exercises installer artifact rendering through the shared helper and through `install.js` output, asserting concrete env values appear in each rendered file.

**Step 2: Run test to verify it fails**

Run: `node --test scripts/install.test.mjs`
Expected: FAIL because the helper or installer path does not yet render templates.

**Step 3: Write minimal implementation**

Add a shared helper in `scripts/lib.mjs` that loads installer templates and renders them with a fixed installer variable mapping. Update `writeInstallerArtifacts()` in `scripts/install.js` to use that helper instead of inline builders.

**Step 4: Run test to verify it passes**

Run: `node --test scripts/install.test.mjs`
Expected: PASS

**Step 5: Verify broader suite**

Run: `npm test`
Expected: PASS
