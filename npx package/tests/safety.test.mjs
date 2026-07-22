import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  HOSTS,
  OWNERSHIP_FILE,
  STATE_DIRECTORY,
} from "../lib/config.mjs";
import {
  inspectTransactionState,
  nativeRelativePath,
  readJson,
  scanTree,
} from "../lib/fs-utils.mjs";
import {
  installCommand,
  uninstallCommand,
} from "../lib/installer.mjs";
import {
  commandOptions,
  exists,
  expectedPaths,
  relativeInventory,
  temporaryRoot,
} from "./helpers.mjs";

test("recorded paths reject traversal, absolute, ambiguous, and control input", () => {
  assert.equal(nativeRelativePath("scripts/tool.py"), path.join("scripts", "tool.py"));
  for (const value of [
    "",
    "/absolute",
    "../outside",
    "nested/../outside",
    "nested//file",
    "nested\\file",
    "nested/\u0000file",
    "nested/\u202efile",
  ]) {
    assert.throws(
      () => nativeRelativePath(value),
      (error) => error.code === "safety_refusal",
    );
  }
});

test("JSON and tree readers reject unsafe endpoint types and size overflow", async (t) => {
  const root = await temporaryRoot(t);
  const directory = path.join(root, "record");
  const oversized = path.join(root, "oversized.json");
  await fs.mkdir(directory);
  await fs.writeFile(oversized, '{"value":"too large"}\n');

  await assert.rejects(
    () => readJson(directory),
    (error) => error.code === "safety_refusal",
  );
  await assert.rejects(
    () => readJson(oversized, { maxBytes: 8 }),
    (error) => error.code === "safety_refusal",
  );

  if (process.platform !== "win32") {
    const file = path.join(root, "target.json");
    const link = path.join(root, "record.json");
    await fs.writeFile(file, "{}\n");
    try {
      await fs.symlink(file, link);
    } catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") {
        t.diagnostic("symbolic links are unavailable in this environment");
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => readJson(link),
      (error) => error.code === "safety_refusal",
    );
    await assert.rejects(
      () => scanTree(root),
      (error) => error.code === "safety_refusal",
    );
  }
});

test("duplicate host discovery refuses installation even with --force", async (t) => {
  const root = await temporaryRoot(t);
  const duplicate = path.join(
    root,
    ...HOSTS["claude-code"].core.project,
    "SKILL.md",
  );
  await fs.mkdir(path.dirname(duplicate), { recursive: true });
  await fs.writeFile(duplicate, "---\nname: low-fidelity-ux-designer\n---\n");

  const options = commandOptions("install", "codex", root, {
    force: true,
  });
  await assert.rejects(
    () => installCommand(options, { cwd: root }),
    (error) =>
      error.code === "conflict" &&
      Array.isArray(error.details.duplicates),
  );
  assert.equal(
    await exists(expectedPaths(root, "codex").core),
    false,
  );
});

test("uninstall refuses corrupt ownership even with --force", async (t) => {
  const root = await temporaryRoot(t);
  const host = "codex";
  const runtime = { cwd: root };
  const installOptions = commandOptions("install", host, root, {
    noReviewAdapter: true,
  });
  const paths = expectedPaths(root, host);

  await installCommand(installOptions, runtime);
  const retained = path.join(paths.core, "retained.txt");
  await fs.writeFile(retained, "retain me\n");
  await fs.writeFile(
    path.join(paths.core, OWNERSHIP_FILE),
    "{not valid json\n",
  );

  await assert.rejects(
    () =>
      uninstallCommand(
        {
          ...installOptions,
          command: "uninstall",
          noReviewAdapter: false,
          force: true,
        },
        runtime,
      ),
    (error) => error.code === "conflict",
  );
  assert.equal(await fs.readFile(retained, "utf8"), "retain me\n");
});

test("symlinked adapters are refused or explicitly preserved, never followed", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link permissions vary on Windows");
    return;
  }

  const root = await temporaryRoot(t);
  const host = "opencode";
  const runtime = { cwd: root };
  const full = commandOptions("install", host, root);
  const coreOnly = { ...full, noReviewAdapter: true };
  const paths = expectedPaths(root, host);
  const outside = path.join(root, "outside-adapter.txt");
  await fs.writeFile(outside, "outside remains unchanged\n");
  await fs.mkdir(path.dirname(paths.adapter), { recursive: true });
  try {
    await fs.symlink(outside, paths.adapter);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("symbolic links are unavailable in this environment");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => installCommand(full, runtime),
    (error) => error.code === "safety_refusal",
  );
  assert.equal(await exists(paths.core), false);

  const installed = await installCommand(coreOnly, runtime);
  assert.equal(
    installed.warnings.some(
      (warning) => warning.code === "unmanaged_adapter_preserved",
    ),
    true,
  );
  await uninstallCommand(
    {
      ...coreOnly,
      command: "uninstall",
      noReviewAdapter: false,
    },
    runtime,
  );
  assert.equal((await fs.lstat(paths.adapter)).isSymbolicLink(), true);
  assert.equal(
    await fs.readFile(outside, "utf8"),
    "outside remains unchanged\n",
  );
});

test("adapter commit failure rolls back the newly committed core", async (t) => {
  const root = await temporaryRoot(t);
  const host = "claude-code";
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);

  await assert.rejects(
    () =>
      installCommand(options, {
        cwd: root,
        fsOps: {
          async copyFile(source, destination, flags) {
            if (path.resolve(destination) === path.resolve(paths.adapter)) {
              const error = new Error("injected adapter commit failure");
              error.code = "EIO";
              throw error;
            }
            return fs.copyFile(source, destination, flags);
          },
        },
      }),
    (error) => error.code === "EIO",
  );

  assert.equal(await exists(paths.core), false);
  assert.equal(await exists(paths.adapter), false);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    false,
  );
});

test("failed upgrade restores the prior core and adapter exactly", async (t) => {
  const root = await temporaryRoot(t);
  const host = "opencode";
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);
  await installCommand(options, { cwd: root });

  const markerPath = path.join(paths.core, OWNERSHIP_FILE);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.package_version = "0.0.1";
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  const before = await relativeInventory(root);
  let injected = false;

  await assert.rejects(
    () =>
      installCommand(options, {
        cwd: root,
        fsOps: {
          async copyFile(source, destination, flags) {
            if (
              !injected &&
              path.resolve(destination) === path.resolve(paths.adapter)
            ) {
              injected = true;
              const error = new Error("injected upgrade failure");
              error.code = "EIO";
              throw error;
            }
            return fs.copyFile(source, destination, flags);
          },
        },
      }),
    (error) => error.code === "EIO",
  );

  assert.equal(injected, true);
  assert.deepEqual(await relativeInventory(root), before);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    false,
  );
});

test("ambiguous path identity changes preserve recovery state", async (t) => {
  const root = await temporaryRoot(t);
  const host = "claude-code";
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);
  let changedParent = null;

  await assert.rejects(
    () =>
      installCommand(options, {
        cwd: root,
        fsOps: {
          async copyFile(source, destination, flags) {
            const result = await fs.copyFile(source, destination, flags);
            if (path.resolve(destination) === path.resolve(paths.adapter)) {
              const parent = path.dirname(destination);
              changedParent = `${parent}-changed`;
              await fs.rename(parent, changedParent);
            }
            return result;
          },
        },
      }),
    (error) => {
      assert.equal(error.code, "path_identity_changed");
      assert.equal(error.details.recovery_required, true);
      assert.equal(typeof error.details.recovery_path, "string");
      return true;
    },
  );

  assert.notEqual(changedParent, null);
  assert.equal(await exists(changedParent), true);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    true,
  );
});

test("rollback failure reports recovery state instead of deleting evidence", async (t) => {
  const root = await temporaryRoot(t);
  const host = "codex";
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);

  await assert.rejects(
    () =>
      installCommand(options, {
        cwd: root,
        fsOps: {
          async copyFile(source, destination, flags) {
            if (path.resolve(destination) === path.resolve(paths.adapter)) {
              const error = new Error("injected adapter failure");
              error.code = "EIO";
              throw error;
            }
            return fs.copyFile(source, destination, flags);
          },
          async rm(target, options_) {
            if (path.resolve(target) === path.resolve(paths.core)) {
              const error = new Error("injected rollback failure");
              error.code = "EIO";
              throw error;
            }
            return fs.rm(target, options_);
          },
        },
      }),
    (error) => {
      assert.equal(error.code, "rollback_failed");
      assert.equal(typeof error.details.recovery_path, "string");
      return true;
    },
  );

  assert.equal(await exists(paths.core), true);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    true,
  );
});

test("post-commit cleanup failure is explicit and blocks later mutation", async (t) => {
  const root = await temporaryRoot(t);
  const host = "codex";
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);

  await assert.rejects(
    () =>
      installCommand(options, {
        cwd: root,
        fsOps: {
          async rm(target, options_) {
            const transactionSegment = [
              STATE_DIRECTORY,
              "transactions",
            ].join(path.sep);
            if (target.includes(transactionSegment)) {
              const error = new Error("injected cleanup failure");
              error.code = "EIO";
              throw error;
            }
            return fs.rm(target, options_);
          },
        },
      }),
    (error) => {
      assert.equal(error.code, "cleanup_failed");
      assert.equal(typeof error.details.recovery_path, "string");
      return true;
    },
  );

  assert.equal(await exists(paths.core), true);
  assert.equal(await exists(paths.adapter), true);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    true,
  );
  await assert.rejects(
    () => uninstallCommand(
      {
        ...options,
        command: "uninstall",
        noReviewAdapter: false,
      },
      { cwd: root },
    ),
    (error) => error.code === "safety_refusal",
  );
});

test("post-uninstall cleanup failure preserves recoverable transaction data", async (t) => {
  const root = await temporaryRoot(t);
  const host = "opencode";
  const installOptions = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);
  await installCommand(installOptions, { cwd: root });

  await assert.rejects(
    () =>
      uninstallCommand(
        {
          ...installOptions,
          command: "uninstall",
          noReviewAdapter: false,
        },
        {
          cwd: root,
          fsOps: {
            async rm(target, options_) {
              const transactionSegment = [
                STATE_DIRECTORY,
                "transactions",
              ].join(path.sep);
              if (target.includes(transactionSegment)) {
                const error = new Error("injected cleanup failure");
                error.code = "EIO";
                throw error;
              }
              return fs.rm(target, options_);
            },
          },
        },
      ),
    (error) => {
      assert.equal(error.code, "cleanup_failed");
      assert.equal(typeof error.details.transaction_path, "string");
      return true;
    },
  );

  assert.equal(await exists(paths.core), false);
  assert.equal(await exists(paths.adapter), false);
  assert.equal(
    (await inspectTransactionState(root, STATE_DIRECTORY)).incomplete,
    true,
  );
});

test("uninstall dry-run leaves the managed tree byte-for-byte unchanged", async (t) => {
  const root = await temporaryRoot(t);
  const host = "codex";
  const runtime = { cwd: root };
  const installOptions = commandOptions("install", host, root);
  await installCommand(installOptions, runtime);
  const before = await relativeInventory(root);

  const result = await uninstallCommand(
    {
      ...installOptions,
      command: "uninstall",
      noReviewAdapter: false,
      dryRun: true,
    },
    runtime,
  );
  assert.equal(result.dry_run, true);
  assert.ok(result.actions.some((action) => action.type === "remove"));
  assert.deepEqual(await relativeInventory(root), before);
});
