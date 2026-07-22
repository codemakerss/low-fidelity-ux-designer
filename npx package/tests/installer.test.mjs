import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { HOST_NAMES, OWNERSHIP_FILE } from "../lib/config.mjs";
import { doctorCommand } from "../lib/doctor.mjs";
import {
  installCommand,
  uninstallCommand,
} from "../lib/installer.mjs";
import {
  inspectInstallation,
  renderReviewAdapter,
} from "../lib/managed-state.mjs";
import { resolveTargets } from "../lib/targets.mjs";
import {
  collectStrings,
  commandOptions,
  exists,
  expectedPaths,
  fakeDoctorRuntime,
  temporaryRoot,
} from "./helpers.mjs";

function runtimeFor(scope, root) {
  return scope === "user" ? { home: root } : { cwd: root };
}

for (const host of HOST_NAMES) {
  for (const scope of ["project", "user"]) {
    test(`${host} ${scope} lifecycle is portable and reversible`, async (t) => {
      const root = await temporaryRoot(t);
      const runtime = runtimeFor(scope, root);
      const installOptions = commandOptions(
        "install",
        host,
        root,
        { scope },
      );
      const paths = expectedPaths(root, host, scope);

      const installed = await installCommand(installOptions, runtime);
      assert.equal(installed.ok, true);
      assert.equal(installed.host, host);
      assert.equal(installed.scope, scope);
      assert.equal(await exists(paths.core), true);
      assert.equal(await exists(paths.adapter), true);

      const marker = JSON.parse(
        await fs.readFile(path.join(paths.core, OWNERSHIP_FILE), "utf8"),
      );
      assert.equal(marker.host, host);
      assert.equal(marker.scope, scope);
      assert.equal(marker.review_adapter.path.includes("\\"), false);
      assert.equal(path.isAbsolute(marker.review_adapter.path), false);
      for (const value of collectStrings(marker)) {
        assert.equal(
          value.includes(root),
          false,
          "ownership data must not contain the resolved installation root",
        );
      }

      const placeholder =
        scope === "user" ? "<user-home>" : "<project-root>";
      const adapter = await fs.readFile(paths.adapter, "utf8");
      assert.equal(adapter.includes(placeholder), true);
      assert.equal(adapter.includes("<skill-root>"), false);
      assert.equal(adapter.includes(root), false);

      const inspection = await inspectInstallation(
        await resolveTargets(installOptions, runtime, {
          checkDuplicates: false,
        }),
      );
      assert.equal(inspection.owned, true);
      assert.equal(inspection.unchanged, true);

      const repeated = await installCommand(installOptions, runtime);
      assert.deepEqual(
        repeated.actions.map((action) => action.type),
        ["noop"],
      );

      const doctorFixture = await fakeDoctorRuntime(
        t,
        root,
        host,
        runtime,
      );
      const doctor = await doctorCommand(
        {
          ...installOptions,
          command: "doctor",
          noReviewAdapter: false,
          dryRun: false,
          force: false,
        },
        doctorFixture.runtime,
      );
      assert.equal(doctor.ok, true);
      assert.equal(
        doctor.actions.find((action) => action.name === "installation")
          .status,
        "pass",
      );
      assert.equal(doctorFixture.spawnCalls.length, 1);

      const removed = await uninstallCommand(
        {
          ...installOptions,
          command: "uninstall",
          noReviewAdapter: false,
        },
        runtime,
      );
      assert.equal(removed.ok, true);
      assert.equal(await exists(paths.core), false);
      assert.equal(await exists(paths.adapter), false);
    });
  }
}

test("Windows adapters use portable placeholders and the Python launcher", async (t) => {
  const root = await temporaryRoot(t);

  for (const host of HOST_NAMES) {
    for (const scope of ["project", "user"]) {
      const options = commandOptions("install", host, root, { scope });
      const targets = await resolveTargets(
        options,
        runtimeFor(scope, root),
        { checkDuplicates: false },
      );
      const rendered = await renderReviewAdapter(targets, "win32");
      const placeholder =
        scope === "user" ? "<user-home>" : "<project-root>";
      assert.equal(rendered.content.includes(placeholder), true);
      assert.equal(rendered.content.includes("<skill-root>"), false);
      assert.equal(rendered.content.includes(root), false);
      assert.match(rendered.content, /\bpy -3\b/);
    }
  }
});

test("core-only state removes an owned adapter but preserves an unowned one", async (t) => {
  const root = await temporaryRoot(t);
  const host = "codex";
  const runtime = { cwd: root };
  const full = commandOptions("install", host, root);
  const coreOnly = {
    ...full,
    noReviewAdapter: true,
  };
  const paths = expectedPaths(root, host);

  await installCommand(full, runtime);
  const transition = await installCommand(coreOnly, runtime);
  assert.ok(
    transition.actions.some((action) => action.type === "remove_adapter"),
  );
  assert.equal(await exists(paths.adapter), false);

  const targets = await resolveTargets(coreOnly, runtime, {
    checkDuplicates: false,
    checkAdapterSafety: false,
  });
  const inspection = await inspectInstallation(targets);
  assert.equal(inspection.marker.review_adapter, null);

  await fs.mkdir(path.dirname(paths.adapter), { recursive: true });
  await fs.writeFile(paths.adapter, "unowned adapter\n");
  const repeated = await installCommand(coreOnly, runtime);
  assert.equal(
    repeated.warnings.some(
      (warning) => warning.code === "unmanaged_adapter_preserved",
    ),
    true,
  );

  const removed = await uninstallCommand(
    {
      ...coreOnly,
      command: "uninstall",
      noReviewAdapter: false,
    },
    runtime,
  );
  assert.equal(
    removed.warnings.some(
      (warning) => warning.code === "unmanaged_adapter_preserved",
    ),
    true,
  );
  assert.equal(await fs.readFile(paths.adapter, "utf8"), "unowned adapter\n");
  assert.equal(await exists(paths.core), false);
});

test("--force backs up unowned conflicts before installing managed content", async (t) => {
  const root = await temporaryRoot(t);
  const host = "claude-code";
  const runtime = { cwd: root };
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);
  const coreSentinel = path.join(paths.core, "keep.txt");

  await fs.mkdir(paths.core, { recursive: true });
  await fs.writeFile(coreSentinel, "unowned core\n");
  await fs.mkdir(path.dirname(paths.adapter), { recursive: true });
  await fs.writeFile(paths.adapter, "unowned adapter\n");

  await assert.rejects(
    () => installCommand(options, runtime),
    (error) => error.code === "conflict",
  );
  assert.equal(await fs.readFile(coreSentinel, "utf8"), "unowned core\n");
  assert.equal(await fs.readFile(paths.adapter, "utf8"), "unowned adapter\n");

  const result = await installCommand(
    { ...options, force: true },
    runtime,
  );
  const backups = result.actions.filter((action) => action.type === "backup");
  assert.equal(backups.length, 2);
  const coreBackup = backups.find((action) => action.path === paths.core);
  const adapterBackup = backups.find(
    (action) => action.path === paths.adapter,
  );
  assert.equal(
    await fs.readFile(path.join(coreBackup.destination, "keep.txt"), "utf8"),
    "unowned core\n",
  );
  assert.equal(
    await fs.readFile(adapterBackup.destination, "utf8"),
    "unowned adapter\n",
  );

  const targets = await resolveTargets(options, runtime, {
    checkDuplicates: false,
  });
  assert.equal((await inspectInstallation(targets)).unchanged, true);
});

test("a newer managed version requires an explicit backed-up replacement", async (t) => {
  const root = await temporaryRoot(t);
  const host = "opencode";
  const runtime = { cwd: root };
  const options = commandOptions("install", host, root);
  const paths = expectedPaths(root, host);

  await installCommand(options, runtime);
  const markerPath = path.join(paths.core, OWNERSHIP_FILE);
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.package_version = "99.0.0";
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  await assert.rejects(
    () => installCommand(options, runtime),
    (error) =>
      error.code === "conflict" &&
      error.details.conflicts.some(
        (conflict) => conflict.type === "newer_managed_version",
      ),
  );

  const replaced = await installCommand(
    { ...options, force: true },
    runtime,
  );
  assert.equal(
    replaced.actions.some((action) => action.type === "backup"),
    true,
  );
  const installedMarker = JSON.parse(
    await fs.readFile(markerPath, "utf8"),
  );
  assert.notEqual(installedMarker.package_version, "99.0.0");
});
