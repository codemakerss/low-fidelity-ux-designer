import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { HELP, parseArguments, runCli } from "../lib/cli.mjs";
import {
  PACKAGE_META,
  PACKAGE_VERSION,
} from "../lib/config.mjs";
import {
  memoryStream,
  PACKAGE_ROOT,
  relativeInventory,
  temporaryRoot,
} from "./helpers.mjs";

function assertUsageError(action) {
  assert.throws(action, (error) => {
    assert.equal(error.code, "invalid_usage");
    assert.equal(error.exitCode, 2);
    return true;
  });
}

test("package metadata keeps the runtime zero-dependency and lifecycle-free", () => {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    assert.equal(Object.hasOwn(PACKAGE_META, field), false);
  }
  for (const script of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "publish",
    "postpublish",
    "preversion",
    "version",
    "postversion",
  ]) {
    assert.equal(Object.hasOwn(PACKAGE_META.scripts, script), false);
  }
  assert.deepEqual(PACKAGE_META.files, [
    "bin",
    "lib",
    "skill",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(PACKAGE_META.publishConfig.provenance, false);
});

test("parseArguments exposes help, version, and stable defaults", () => {
  assert.deepEqual(parseArguments([]), { mode: "help" });
  assert.deepEqual(parseArguments(["--help"]), { mode: "help" });
  assert.deepEqual(parseArguments(["--version"]), { mode: "version" });

  const parsed = parseArguments(["install", "--host=codex"]);
  assert.equal(parsed.mode, "command");
  assert.deepEqual(parsed.options, {
    command: "install",
    host: "codex",
    scope: "project",
    projectRoot: undefined,
    projectRootProvided: false,
    noReviewAdapter: false,
    dryRun: false,
    json: false,
    force: false,
    help: false,
  });

  const explicit = parseArguments([
    "install",
    "--host",
    "opencode",
    "--scope",
    "user",
    "--no-review-adapter",
    "--dry-run",
    "--json",
    "--force",
  ]);
  assert.equal(explicit.options.host, "opencode");
  assert.equal(explicit.options.scope, "user");
  assert.equal(explicit.options.noReviewAdapter, true);
  assert.equal(explicit.options.dryRun, true);
  assert.equal(explicit.options.json, true);
  assert.equal(explicit.options.force, true);
});

test("parseArguments rejects ambiguous and command-incompatible input", () => {
  const invalidCases = [
    ["unknown"],
    ["install"],
    ["install", "--host", "all"],
    ["install", "--host", "codex", "--scope", "workspace"],
    ["install", "--host", "codex", "--host", "opencode"],
    ["install", "--host"],
    ["install", "--host", "codex", "--unknown"],
    [
      "install",
      "--host",
      "codex",
      "--scope",
      "user",
      "--project-root",
      "project",
    ],
    ["doctor", "--host", "codex", "--force"],
    ["doctor", "--host", "codex", "--dry-run"],
    ["uninstall", "--host", "codex", "--no-review-adapter"],
    ["--version", "--json"],
  ];

  for (const argv of invalidCases) {
    assertUsageError(() => parseArguments(argv));
  }
});

test("runCli emits one JSON failure object and exit code 2 for invalid usage", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const exitCode = await runCli(
    ["install", "--host", "all", "--json"],
    { stdout, stderr },
  );

  assert.equal(exitCode, 2);
  const lines = stdout.text.trim().split("\n");
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]);
  assert.equal(result.ok, false);
  assert.equal(result.command, "install");
  assert.equal(result.error.code, "invalid_usage");
  assert.equal(result.host, null);
  assert.match(stderr.text, /^ERROR: /);
});

test("runCli help and version are read-only", async () => {
  const helpOut = memoryStream();
  const helpErr = memoryStream();
  assert.equal(
    await runCli([], { stdout: helpOut, stderr: helpErr }),
    0,
  );
  assert.equal(helpOut.text, HELP);
  assert.equal(helpErr.text, "");

  const versionOut = memoryStream();
  const versionErr = memoryStream();
  assert.equal(
    await runCli(["--version"], {
      stdout: versionOut,
      stderr: versionErr,
    }),
    0,
  );
  assert.equal(versionOut.text, `${PACKAGE_VERSION}\n`);
  assert.equal(versionErr.text, "");
});

test("the published bin entry invokes the CLI without a shell", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(PACKAGE_ROOT, "bin", "low-fidelity-ux-designer.mjs"), "--version"],
    {
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${PACKAGE_VERSION}\n`);
  assert.equal(result.stderr, "");
});

test("CLI install dry-run defaults the project root to cwd without changes", async (t) => {
  const root = await temporaryRoot(t);
  const stdout = memoryStream();
  const stderr = memoryStream();
  const before = await relativeInventory(root);

  const exitCode = await runCli(
    [
      "install",
      "--host",
      "claude-code",
      "--dry-run",
      "--json",
    ],
    {
      cwd: root,
      stdout,
      stderr,
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr.text, "");
  const result = JSON.parse(stdout.text);
  assert.equal(result.ok, true);
  assert.equal(result.command, "install");
  assert.equal(result.host, "claude-code");
  assert.equal(result.dry_run, true);
  assert.ok(result.actions.some((action) => action.type === "install"));
  assert.deepEqual(await relativeInventory(root), before);
});
