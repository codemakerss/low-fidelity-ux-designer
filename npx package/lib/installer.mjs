import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  OWNERSHIP_FILE,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PAYLOAD_ROOT,
  STATE_DIRECTORY,
} from "./config.mjs";
import { CliError, conflictError, safetyError } from "./errors.mjs";
import {
  assertPathGuard,
  assertSafeDestination,
  capturePathGuard,
  guardedEntry,
  hashFile,
  inspectTransactionState,
  lstatOrNull,
  nativeRelativePath,
  pathExists,
  readJson,
  scanTree,
} from "./fs-utils.mjs";
import {
  buildOwnershipRecord,
  desiredMatches,
  inspectInstallation,
  payloadMatches,
  renderReviewAdapter,
  validateOwnershipRecord,
  validatePayload,
} from "./managed-state.mjs";
import { resolveTargets } from "./targets.mjs";

function resultEnvelope(command, options, actions = [], warnings = []) {
  return {
    ok: true,
    command,
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    host: options.host,
    scope: options.scope ?? "project",
    dry_run: Boolean(options.dryRun),
    actions,
    warnings,
  };
}

function targetFromRelative(root, relative) {
  return path.join(root, nativeRelativePath(relative));
}

function backupRelative(relative) {
  return relative;
}

function filesystemOperations(runtime) {
  return {
    rename: runtime.fsOps?.rename ?? runtime.rename ?? fs.rename,
    copyFile: runtime.fsOps?.copyFile ?? fs.copyFile,
    mkdir: runtime.fsOps?.mkdir ?? fs.mkdir,
    rm: runtime.fsOps?.rm ?? fs.rm,
    rmdir: runtime.fsOps?.rmdir ?? fs.rmdir,
    writeFile: runtime.fsOps?.writeFile ?? fs.writeFile,
    chmod: runtime.fsOps?.chmod ?? fs.chmod,
  };
}

async function assertGuards(guards) {
  for (const guard of guards.filter(Boolean)) {
    await assertPathGuard(guard);
  }
}

function uncertainMutationError(label, cause, verification = null) {
  return safetyError(
    `${label} outcome could not be verified; recovery is required`,
    {
      path: verification?.details?.path ?? cause?.details?.path ?? null,
      reason: "path_identity_changed",
      recovery_required: true,
      mutation_started: true,
      cause_code: cause?.code ?? null,
    },
  );
}

function requiresRecovery(error) {
  return Boolean(
    error?.details?.reason === "path_identity_changed" ||
      error?.details?.recovery_required,
  );
}

async function guardedMutation({
  label,
  stableGuards = [],
  preGuards = [],
  mutate,
  verifyAfter = null,
}) {
  await assertGuards([...stableGuards, ...preGuards]);
  let result;
  try {
    result = await mutate();
  } catch (error) {
    try {
      await assertGuards([...stableGuards, ...preGuards]);
    } catch (verificationError) {
      throw uncertainMutationError(label, error, verificationError);
    }
    throw error;
  }

  try {
    await assertGuards(stableGuards);
    return verifyAfter ? await verifyAfter(result) : result;
  } catch (verificationError) {
    throw uncertainMutationError(label, null, verificationError);
  }
}

function assertSameTargets(initial, refreshed) {
  if (
    initial.root !== refreshed.root ||
    initial.core !== refreshed.core ||
    initial.adapter !== refreshed.adapter
  ) {
    throw safetyError("the selected installation root changed during the operation", {
      initial_root: initial.root,
      refreshed_root: refreshed.root,
    });
  }
}

async function createDirectorySafely(
  targets,
  directory,
  label,
  guards = [],
  operations = filesystemOperations({}),
  mode = 0o755,
) {
  await assertGuards(guards);
  const lexicalDirectory = await assertSafeDestination(
    targets.root,
    directory,
    label,
  );
  const before = await capturePathGuard(
    targets.root,
    lexicalDirectory,
    label,
  );
  await assertPathGuard(before);
  const originalAncestors = { ...before, missing: [] };
  const relative = path.relative(targets.root, lexicalDirectory);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let cursor = targets.root;
  const createdGuards = [];

  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const expectedMissing = before.missing.includes(cursor);
    const current = await capturePathGuard(
      targets.root,
      cursor,
      `${label} segment`,
    );
    const currentEntry = guardedEntry(current);
    if (!expectedMissing) {
      await assertPathGuard(current);
      if (!currentEntry || currentEntry.kind !== "directory") {
        throw safetyError(`${label} has a non-directory segment`, {
          path: cursor,
        });
      }
      continue;
    }
    if (currentEntry) {
      throw safetyError(`${label} changed during directory creation`, {
        path: cursor,
        reason: "path_identity_changed",
      });
    }

    const parentGuard = await capturePathGuard(
      targets.root,
      path.dirname(cursor),
      `${label} parent`,
    );
    const createdGuard = await guardedMutation({
      label: `${label} segment creation`,
      stableGuards: [...guards, originalAncestors, parentGuard],
      preGuards: [current],
      mutate: () => operations.mkdir(cursor, { mode }),
      verifyAfter: async () => {
        await assertPathGuard({ ...current, missing: [] });
        const created = await capturePathGuard(
          targets.root,
          cursor,
          `${label} created segment`,
        );
        const createdEntry = requireExistingEntry(created);
        if (createdEntry.kind !== "directory") {
          throw safetyError(`${label} created a non-directory segment`, {
            path: cursor,
          });
        }
        return created;
      },
    });
    createdGuards.push(createdGuard);
  }

  await assertGuards([
    ...guards,
    originalAncestors,
    ...createdGuards,
  ]);
  const after = await capturePathGuard(
    targets.root,
    lexicalDirectory,
    label,
  );
  const entry = guardedEntry(after);
  if (!entry || entry.kind !== "directory") {
    throw safetyError(`${label} is not a managed directory`, {
      path: lexicalDirectory,
    });
  }
  return after;
}

function requireExistingEntry(guard) {
  const entry = guardedEntry(guard);
  if (!entry) {
    throw safetyError(`${guard.label} disappeared during the operation`, {
      path: guard.target,
    });
  }
  return entry;
}

async function verifyTransferredEntry(sourceGuard, destination, label) {
  const sourceEntry = requireExistingEntry(sourceGuard);
  const destinationGuard = await capturePathGuard(
    sourceGuard.root,
    destination,
    label,
  );
  const destinationEntry = requireExistingEntry(destinationGuard);
  if (
    sourceEntry.dev !== destinationEntry.dev ||
    sourceEntry.ino !== destinationEntry.ino ||
    sourceEntry.kind !== destinationEntry.kind
  ) {
    throw safetyError(`${label} changed while it was being transferred`, {
      path: destination,
      reason: "path_identity_changed",
    });
  }
  return destinationGuard;
}

async function removeGuarded(
  guard,
  operations,
  { recursive = true, stableGuards = [] } = {},
) {
  const parentGuard = await capturePathGuard(
    guard.root,
    path.dirname(guard.target),
    `${guard.label} parent`,
  );
  await guardedMutation({
    label: `${guard.label} removal`,
    stableGuards: [...stableGuards, parentGuard],
    preGuards: [guard],
    mutate: () =>
      operations.rm(guard.target, { recursive, force: false }),
    verifyAfter: async () => {
      if (await lstatOrNull(guard.target)) {
        throw safetyError(
          `${guard.label} changed while it was being removed`,
          {
            path: guard.target,
            reason: "path_identity_changed",
          },
        );
      }
    },
  });
}

async function removeEmptyGuarded(guard, operations, stableGuards = []) {
  const parentGuard = await capturePathGuard(
    guard.root,
    path.dirname(guard.target),
    `${guard.label} parent`,
  );
  let removed = false;
  try {
    await guardedMutation({
      label: `${guard.label} empty-directory removal`,
      stableGuards: [...stableGuards, parentGuard],
      preGuards: [guard],
      mutate: () => operations.rmdir(guard.target),
      verifyAfter: async () => {
        if (await lstatOrNull(guard.target)) {
          throw safetyError(
            `${guard.label} changed while it was being removed`,
            {
              path: guard.target,
              reason: "path_identity_changed",
            },
          );
        }
        removed = true;
      },
    });
  } catch (error) {
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") {
      await assertGuards([...stableGuards, parentGuard, guard]);
      return false;
    }
    throw error;
  }
  return removed;
}

async function assertNoIncompleteTransaction(targets) {
  const transactionState = await inspectTransactionState(
    targets.root,
    STATE_DIRECTORY,
  );
  if (transactionState.incomplete) {
    throw safetyError(
      "an incomplete transaction requires recovery before another change",
      {
        recovery_path: transactionState.path,
      },
    );
  }
}

async function adapterMetadata(targets, { rejectSymlink = true } = {}) {
  const metadata = await lstatOrNull(targets.adapter);
  if (rejectSymlink && metadata?.isSymbolicLink()) {
    throw safetyError("review adapter destination must not be a symbolic link", {
      path: targets.adapter,
    });
  }
  return metadata;
}

function conflictDetails(conflicts) {
  return {
    conflicts: conflicts.map((item) => ({
      type: item.type,
      path: item.path,
      issues: item.issues ?? [],
    })),
  };
}

function parseVersion(version) {
  const buildSeparator = version.indexOf("+");
  const withoutBuild =
    buildSeparator === -1 ? version : version.slice(0, buildSeparator);
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const core =
    prereleaseSeparator === -1
      ? withoutBuild
      : withoutBuild.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1
      ? null
      : withoutBuild.slice(prereleaseSeparator + 1);
  return {
    core: core.split(".").map(Number),
    prerelease: prerelease?.split(".") ?? null,
  };
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  if (left.prerelease === null || right.prerelease === null) {
    if (left.prerelease === right.prerelease) {
      return 0;
    }
    return left.prerelease === null ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) > Number(rightIdentifier) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

function ownershipSnapshot(marker) {
  return JSON.stringify({
    package_version: marker.package_version,
    host: marker.host,
    scope: marker.scope,
    owned_files: [...marker.owned_files]
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    review_adapter: marker.review_adapter
      ? {
          path: marker.review_adapter.path,
          sha256: marker.review_adapter.sha256,
        }
      : null,
  });
}

async function classifyInstall(targets, payload, desiredAdapter, options) {
  const current = await inspectInstallation(targets);
  const touchesAdapter = Boolean(
    desiredAdapter || (current.owned && current.marker?.review_adapter),
  );
  if (touchesAdapter) {
    await assertSafeDestination(
      targets.root,
      targets.adapter,
      "review adapter destination",
    );
  }
  const adapter = await adapterMetadata(targets, {
    rejectSymlink: touchesAdapter,
  });
  const conflicts = [];

  if (current.exists && !current.owned) {
    conflicts.push({
      type: "unowned_core",
      path: targets.core,
      issues: current.issues,
    });
  } else if (current.owned && !current.unchanged) {
    conflicts.push({
      type: "modified_installation",
      path: targets.core,
      issues: current.issues,
    });
  } else if (current.owned && current.unchanged) {
    const versionOrder = compareVersions(
      current.marker.package_version,
      PACKAGE_VERSION,
    );
    if (versionOrder > 0) {
      conflicts.push({
        type: "newer_managed_version",
        path: targets.core,
        issues: [
          `installed ${current.marker.package_version} is newer than package ${PACKAGE_VERSION}`,
        ],
      });
    } else if (
      versionOrder === 0 &&
      !payloadMatches(current.marker, payload)
    ) {
      conflicts.push({
        type: "same_version_payload_mismatch",
        path: targets.core,
        issues: [
          `installed payload differs from package ${PACKAGE_VERSION}`,
        ],
      });
    }
  }

  const adapterIsOwned = Boolean(current.owned && current.marker?.review_adapter);
  if (desiredAdapter && adapter && !adapterIsOwned) {
    conflicts.push({
      type: "unowned_adapter",
      path: targets.adapter,
    });
  }

  if (conflicts.length > 0 && !options.force) {
    throw conflictError(
      "installation conflicts must be resolved or explicitly backed up with --force",
      conflictDetails(conflicts),
    );
  }

  const noOp =
    current.owned &&
    current.unchanged &&
    desiredMatches(current.marker, payload, desiredAdapter);

  const existing = [];
  if (current.exists) {
    existing.push({
      kind: "core",
      path: targets.core,
      relative: targets.coreRelative,
    });
  }
  if (
    adapter &&
    (Boolean(desiredAdapter) || Boolean(current.owned && current.marker?.review_adapter))
  ) {
    existing.push({
      kind: "adapter",
      path: targets.adapter,
      relative: targets.adapterRelative,
    });
  }

  let mode = "install";
  if (noOp) {
    mode = "noop";
  } else if (conflicts.length > 0) {
    mode = "replace";
  } else if (current.owned && current.unchanged) {
    mode = "upgrade";
  } else if (current.exists) {
    mode = "replace";
  }

  return {
    current,
    conflicts,
    existing,
    mode,
    permanentBackup: Boolean(options.force && conflicts.length > 0),
    unmanagedAdapterPreserved: Boolean(
      !touchesAdapter && adapter,
    ),
  };
}

function preservedAdapterWarnings(plan, targets) {
  if (!plan.unmanagedAdapterPreserved) {
    return [];
  }
  return [
    {
      code: "unmanaged_adapter_preserved",
      message: `An unowned review adapter was preserved at ${targets.adapter}.`,
    },
  ];
}

function installActions(plan, targets, desiredAdapter, backupRoot = null) {
  if (plan.mode === "noop") {
    return [
      {
        type: "noop",
        path: targets.core,
        message: "The managed installation already matches this package.",
      },
    ];
  }

  const actions = [];
  if (plan.permanentBackup && backupRoot) {
    for (const item of plan.existing) {
      actions.push({
        type: "backup",
        path: item.path,
        destination: targetFromRelative(
          backupRoot,
          backupRelative(item.relative),
        ),
      });
    }
  }
  actions.push({
    type: plan.mode,
    path: targets.core,
  });
  if (desiredAdapter) {
    actions.push({
      type: "install_adapter",
      path: targets.adapter,
    });
  } else if (plan.current.marker?.review_adapter) {
    actions.push({
      type: "remove_adapter",
      path: targets.adapter,
    });
  }
  return actions;
}

async function verifyMovedSnapshot(plan, storageRoot, targets) {
  if (
    plan.permanentBackup ||
    !plan.current.owned ||
    plan.existing.length === 0
  ) {
    return;
  }
  const storedTargets = {
    ...targets,
    core: targetFromRelative(storageRoot, targets.coreRelative),
    adapter: targetFromRelative(storageRoot, targets.adapterRelative),
  };
  const stored = await inspectInstallation(storedTargets);
  if (
    !stored.owned ||
    !stored.unchanged ||
    ownershipSnapshot(stored.marker) !== ownershipSnapshot(plan.current.marker)
  ) {
    throw conflictError(
      "managed content changed during the transaction; the operation was rolled back",
      {
        conflicts: [
          {
            type: "concurrent_modification",
            path: targets.core,
            issues: stored.issues,
          },
        ],
      },
    );
  }
}

async function verifyStagedCore(stagedCore, payload, targets) {
  const marker = validateOwnershipRecord(
    await readJson(path.join(stagedCore, OWNERSHIP_FILE)),
    targets,
  );
  const staged = await scanTree(stagedCore, {
    exclude: new Set([OWNERSHIP_FILE]),
  });
  const expected = new Map(
    payload.files.map((entry) => [entry.relative, entry.sha256]),
  );
  if (staged.files.length !== expected.size) {
    throw safetyError("staged Skill file inventory does not match the payload");
  }
  for (const file of staged.files) {
    if (expected.get(file.relative) !== file.sha256) {
      throw safetyError(`staged Skill hash mismatch: ${file.relative}`);
    }
  }
  if (marker.owned_files.length !== expected.size) {
    throw safetyError("staged ownership record does not match the payload");
  }
}

async function commitStagedCore(
  stagedCore,
  target,
  targets,
  guards,
  operations,
) {
  const sourceGuard = await capturePathGuard(
    targets.root,
    stagedCore,
    "staged core Skill",
  );
  requireExistingEntry(sourceGuard);
  const targetGuard = await capturePathGuard(
    targets.root,
    target,
    "core Skill destination",
  );
  if (guardedEntry(targetGuard)) {
    throw conflictError(
      "core Skill destination appeared during the transaction",
      {
        conflicts: [
          {
            type: "concurrent_destination",
            path: target,
          },
        ],
      },
    );
  }
  const sourceParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(stagedCore),
    "staged core Skill parent",
  );
  const targetParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(target),
    "core Skill destination parent",
  );
  try {
    return await guardedMutation({
      label: "core Skill commit",
      stableGuards: [
        ...guards,
        sourceParentGuard,
        targetParentGuard,
      ],
      preGuards: [sourceGuard, targetGuard],
      mutate: () => operations.rename(stagedCore, target),
      verifyAfter: async () => {
        await assertPathGuard({ ...targetGuard, missing: [] });
        const sourceAfter = await capturePathGuard(
          targets.root,
          stagedCore,
          "staged core Skill",
        );
        if (guardedEntry(sourceAfter)) {
          throw safetyError(
            "staged core Skill changed while it was being committed",
            {
              path: stagedCore,
              reason: "path_identity_changed",
            },
          );
        }
        return verifyTransferredEntry(
          sourceGuard,
          target,
          "committed core Skill",
        );
      },
    });
  } catch (error) {
    if (
      ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)
    ) {
      throw conflictError(
        "core Skill destination changed during the transaction",
        {
          conflicts: [
            {
              type: "concurrent_destination",
              path: target,
            },
          ],
        },
      );
    }
    throw error;
  }
}

async function commitStagedAdapter(
  stagedAdapter,
  target,
  targets,
  guards,
  operations,
) {
  const sourceGuard = await capturePathGuard(
    targets.root,
    stagedAdapter,
    "staged review adapter",
  );
  requireExistingEntry(sourceGuard);
  const targetGuard = await capturePathGuard(
    targets.root,
    target,
    "review adapter destination",
  );
  if (guardedEntry(targetGuard)) {
    throw conflictError(
      "review adapter destination appeared during the transaction",
      {
        conflicts: [
          {
            type: "concurrent_destination",
            path: target,
          },
        ],
      },
    );
  }
  const sourceParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(stagedAdapter),
    "staged review adapter parent",
  );
  const targetParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(target),
    "review adapter destination parent",
  );
  try {
    return await guardedMutation({
      label: "review adapter commit",
      stableGuards: [
        ...guards,
        sourceGuard,
        sourceParentGuard,
        targetParentGuard,
      ],
      preGuards: [targetGuard],
      mutate: () =>
        operations.copyFile(
          stagedAdapter,
          target,
          fsConstants.COPYFILE_EXCL,
        ),
      verifyAfter: async () => {
        await assertPathGuard({ ...targetGuard, missing: [] });
        const installedGuard = await capturePathGuard(
          targets.root,
          target,
          "committed review adapter",
        );
        const installedEntry = requireExistingEntry(installedGuard);
        if (installedEntry.kind !== "file") {
          throw safetyError(
            "committed review adapter is not a regular file",
            {
              path: target,
            },
          );
        }
        return installedGuard;
      },
    });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw conflictError(
        "review adapter destination appeared during the transaction",
        {
          conflicts: [
            {
              type: "concurrent_destination",
              path: target,
            },
          ],
        },
      );
    }
    throw error;
  }
}

async function statePaths(targets, operationId) {
  const stateRoot = await assertSafeDestination(
    targets.root,
    path.join(targets.root, STATE_DIRECTORY),
    "CLI state directory",
  );
  const transactionRoot = await assertSafeDestination(
    targets.root,
    path.join(stateRoot, "transactions", operationId),
    "transaction directory",
  );
  const backupRoot = await assertSafeDestination(
    targets.root,
    path.join(stateRoot, "backups", operationId),
    "backup directory",
  );
  return {
    stateRoot,
    transactionRoot,
    backupRoot,
    stagedCore: path.join(transactionRoot, "next", "core"),
    stagedAdapter: path.join(transactionRoot, "next", "review-adapter"),
    previousRoot: path.join(transactionRoot, "previous"),
    stateGuard: null,
    transactionsGuard: null,
    backupsGuard: null,
    transactionGuard: null,
    backupGuard: null,
  };
}

async function initializeTransactionState(
  paths,
  targets,
  initialDirectory,
  guards,
  operations,
) {
  const vacancyGuard = await capturePathGuard(
    targets.root,
    paths.transactionRoot,
    "transaction directory",
  );
  if (guardedEntry(vacancyGuard)) {
    throw safetyError("transaction directory is already occupied", {
      path: paths.transactionRoot,
    });
  }
  await assertPathGuard(vacancyGuard);
  await createDirectorySafely(
    targets,
    paths.transactionRoot,
    "transaction directory",
    guards,
    operations,
    0o700,
  );
  try {
    paths.stateGuard = await capturePathGuard(
      targets.root,
      paths.stateRoot,
      "CLI state directory",
    );
    paths.transactionsGuard = await capturePathGuard(
      targets.root,
      path.dirname(paths.transactionRoot),
      "transaction state directory",
    );
    paths.transactionGuard = await capturePathGuard(
      targets.root,
      paths.transactionRoot,
      "transaction directory",
    );
  } catch (error) {
    throw uncertainMutationError(
      "transaction initialization",
      null,
      error,
    );
  }
  await assertGuards([
    ...guards,
    paths.stateGuard,
    paths.transactionsGuard,
    paths.transactionGuard,
  ]);
  if (initialDirectory !== paths.transactionRoot) {
    await createDirectorySafely(
      targets,
      initialDirectory,
      "transaction staging directory",
      [
        ...guards,
        paths.stateGuard,
        paths.transactionsGuard,
        paths.transactionGuard,
      ],
      operations,
      0o700,
    );
  }
}

async function moveTarget(
  item,
  destinationRoot,
  targets,
  moved,
  guards,
  paths,
  operations,
) {
  await assertGuards(guards);
  const refreshed = await assertSafeDestination(
    targets.root,
    item.path,
    `${item.kind} destination`,
  );
  if (!(await pathExists(refreshed))) {
    return;
  }
  await assertSafeDestination(
    targets.root,
    destinationRoot,
    "transaction storage directory",
  );
  const destination = targetFromRelative(
    destinationRoot,
    backupRelative(item.relative),
  );
  await createDirectorySafely(
    targets,
    path.dirname(destination),
    "transaction storage parent",
    guards,
    operations,
  );
  const sourceGuard = await capturePathGuard(
    targets.root,
    refreshed,
    `${item.kind} source`,
  );
  requireExistingEntry(sourceGuard);
  const destinationGuard = await capturePathGuard(
    targets.root,
    destination,
    `${item.kind} transaction destination`,
  );
  if (guardedEntry(destinationGuard)) {
    throw safetyError("transaction destination is already occupied", {
      path: destination,
    });
  }
  const sourceParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(refreshed),
    `${item.kind} source parent`,
  );
  const destinationParentGuard = await capturePathGuard(
    targets.root,
    path.dirname(destination),
    `${item.kind} transaction parent`,
  );
  const transfer = await guardedMutation({
    label: `${item.kind} transaction move`,
    stableGuards: [
      ...guards,
      sourceParentGuard,
      destinationParentGuard,
    ],
    preGuards: [sourceGuard, destinationGuard],
    mutate: () => operations.rename(refreshed, destination),
    verifyAfter: async () => {
      await assertPathGuard({ ...destinationGuard, missing: [] });
      const storedGuard = await verifyTransferredEntry(
        sourceGuard,
        destination,
        `${item.kind} transaction copy`,
      );
      const originalGuard = await capturePathGuard(
        targets.root,
        refreshed,
        `${item.kind} rollback destination`,
      );
      if (guardedEntry(originalGuard)) {
        throw safetyError(
          "managed source changed while it was being moved",
          {
            path: refreshed,
            reason: "path_identity_changed",
          },
        );
      }
      const storageGuard = await capturePathGuard(
        targets.root,
        destinationRoot,
        "transaction storage directory",
      );
      const backupsGuard =
        destinationRoot === paths.backupRoot
          ? await capturePathGuard(
              targets.root,
              path.dirname(paths.backupRoot),
              "backup state directory",
            )
          : null;
      return {
        originalGuard,
        storedGuard,
        storageGuard,
        backupsGuard,
      };
    },
  });
  moved.push({
    kind: item.kind,
    original: refreshed,
    stored: destination,
    originalGuard: transfer.originalGuard,
    storedGuard: transfer.storedGuard,
  });
  if (destinationRoot === paths.backupRoot) {
    paths.backupGuard = transfer.storageGuard;
    paths.backupsGuard = transfer.backupsGuard;
  }
}

async function rollbackTransaction(
  installed,
  moved,
  guards,
  operations,
) {
  const errors = [];
  for (const installedGuard of [...installed].reverse()) {
    try {
      await assertGuards(guards);
      await removeGuarded(installedGuard, operations, {
        stableGuards: guards,
      });
    } catch (error) {
      errors.push(error);
      throw new AggregateError(
        errors,
        "transaction rollback was incomplete",
      );
    }
  }
  for (const item of [...moved].reverse()) {
    try {
      await assertGuards(guards);
      await assertPathGuard(item.originalGuard);
      await assertPathGuard(item.storedGuard);
      const storedEntry = requireExistingEntry(item.storedGuard);
      if (storedEntry.kind === "file") {
        const storedHash = await hashFile(item.stored);
        const storedParentGuard = await capturePathGuard(
          item.storedGuard.root,
          path.dirname(item.stored),
          `${item.kind} rollback source parent`,
        );
        const originalParentGuard = await capturePathGuard(
          item.originalGuard.root,
          path.dirname(item.original),
          `${item.kind} rollback destination parent`,
        );
        await guardedMutation({
          label: `${item.kind} rollback copy`,
          stableGuards: [
            ...guards,
            item.storedGuard,
            storedParentGuard,
            originalParentGuard,
          ],
          preGuards: [item.originalGuard],
          mutate: () =>
            operations.copyFile(
              item.stored,
              item.original,
              fsConstants.COPYFILE_EXCL,
            ),
          verifyAfter: async () => {
            await assertPathGuard({
              ...item.originalGuard,
              missing: [],
            });
            const restoredGuard = await capturePathGuard(
              item.originalGuard.root,
              item.original,
              `${item.kind} restored destination`,
            );
            const restoredEntry = requireExistingEntry(restoredGuard);
            if (restoredEntry.kind !== "file") {
              throw safetyError("rollback restored a non-file adapter", {
                path: item.original,
              });
            }
            if ((await hashFile(item.original)) !== storedHash) {
              throw safetyError(
                "rollback restored different adapter content",
                {
                  path: item.original,
                },
              );
            }
            await assertPathGuard(restoredGuard);
          },
        });
        await removeGuarded(item.storedGuard, operations, {
          recursive: false,
          stableGuards: guards,
        });
      } else {
        const storedParentGuard = await capturePathGuard(
          item.storedGuard.root,
          path.dirname(item.stored),
          `${item.kind} rollback source parent`,
        );
        const originalParentGuard = await capturePathGuard(
          item.originalGuard.root,
          path.dirname(item.original),
          `${item.kind} rollback destination parent`,
        );
        await guardedMutation({
          label: `${item.kind} rollback move`,
          stableGuards: [
            ...guards,
            storedParentGuard,
            originalParentGuard,
          ],
          preGuards: [item.storedGuard, item.originalGuard],
          mutate: () => operations.rename(item.stored, item.original),
          verifyAfter: async () => {
            await assertPathGuard({
              ...item.originalGuard,
              missing: [],
            });
            await verifyTransferredEntry(
              item.storedGuard,
              item.original,
              `${item.kind} restored destination`,
            );
          },
        });
      }
    } catch (error) {
      errors.push(error);
      throw new AggregateError(
        errors,
        "transaction rollback was incomplete",
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "transaction rollback was incomplete");
  }
}

async function cleanupState(
  paths,
  operations,
  { keepBackup = false } = {},
) {
  if (paths.transactionGuard) {
    await removeGuarded(paths.transactionGuard, operations);
  }
  if (paths.transactionsGuard) {
    await removeEmptyGuarded(paths.transactionsGuard, operations);
  }
  if (!keepBackup && paths.backupGuard) {
    await removeGuarded(paths.backupGuard, operations);
  }
  if (!keepBackup && paths.backupsGuard) {
    await removeEmptyGuarded(paths.backupsGuard, operations);
  }
  if (paths.stateGuard) {
    await removeEmptyGuarded(paths.stateGuard, operations);
  }
}

async function copyFileExclusiveSafely({
  sourceRoot,
  source,
  destinationRoot,
  destination,
  label,
  stableGuards,
  operations,
}) {
  const sourceGuard = await capturePathGuard(sourceRoot, source, `${label} source`);
  const sourceEntry = requireExistingEntry(sourceGuard);
  if (sourceEntry.kind !== "file") {
    throw safetyError(`${label} source is not a regular file`, {
      path: source,
    });
  }
  const destinationGuard = await capturePathGuard(
    destinationRoot,
    destination,
    `${label} destination`,
  );
  if (guardedEntry(destinationGuard)) {
    throw safetyError(`${label} destination is already occupied`, {
      path: destination,
    });
  }
  const sourceParentGuard = await capturePathGuard(
    sourceRoot,
    path.dirname(source),
    `${label} source parent`,
  );
  const destinationParentGuard = await capturePathGuard(
    destinationRoot,
    path.dirname(destination),
    `${label} destination parent`,
  );
  return guardedMutation({
    label,
    stableGuards: [
      ...stableGuards,
      sourceGuard,
      sourceParentGuard,
      destinationParentGuard,
    ],
    preGuards: [destinationGuard],
    mutate: () =>
      operations.copyFile(
        source,
        destination,
        fsConstants.COPYFILE_EXCL,
      ),
    verifyAfter: async () => {
      await assertPathGuard({ ...destinationGuard, missing: [] });
      const copiedGuard = await capturePathGuard(
        destinationRoot,
        destination,
        `${label} copied file`,
      );
      const copiedEntry = requireExistingEntry(copiedGuard);
      if (copiedEntry.kind !== "file") {
        throw safetyError(`${label} created a non-file destination`, {
          path: destination,
        });
      }
      return copiedGuard;
    },
  });
}

async function writeFileExclusiveSafely({
  root,
  destination,
  content,
  label,
  stableGuards,
  operations,
  mode = 0o644,
}) {
  const destinationGuard = await capturePathGuard(root, destination, label);
  if (guardedEntry(destinationGuard)) {
    throw safetyError(`${label} destination is already occupied`, {
      path: destination,
    });
  }
  const parentGuard = await capturePathGuard(
    root,
    path.dirname(destination),
    `${label} parent`,
  );
  return guardedMutation({
    label,
    stableGuards: [...stableGuards, parentGuard],
    preGuards: [destinationGuard],
    mutate: () =>
      operations.writeFile(destination, content, {
        encoding: "utf8",
        mode,
        flag: "wx",
      }),
    verifyAfter: async () => {
      await assertPathGuard({ ...destinationGuard, missing: [] });
      const writtenGuard = await capturePathGuard(
        root,
        destination,
        `${label} written file`,
      );
      const writtenEntry = requireExistingEntry(writtenGuard);
      if (writtenEntry.kind !== "file") {
        throw safetyError(`${label} created a non-file destination`, {
          path: destination,
        });
      }
      return writtenGuard;
    },
  });
}

async function chmodSafely(guard, mode, stableGuards, operations) {
  const parentGuard = await capturePathGuard(
    guard.root,
    path.dirname(guard.target),
    `${guard.label} parent`,
  );
  await guardedMutation({
    label: `${guard.label} mode update`,
    stableGuards: [...stableGuards, parentGuard, guard],
    mutate: () => operations.chmod(guard.target, mode),
    verifyAfter: () => assertPathGuard(guard),
  });
}

async function hashGuardedFile(guard, stableGuards = []) {
  await assertGuards([...stableGuards, guard]);
  const digest = await hashFile(guard.target);
  await assertGuards([...stableGuards, guard]);
  return digest;
}

async function copyPayloadSafely(
  payload,
  destinationRoot,
  targets,
  stableGuards,
  operations,
) {
  for (const file of payload.files) {
    const destination = path.join(
      destinationRoot,
      ...file.relative.split("/"),
    );
    await createDirectorySafely(
      targets,
      path.dirname(destination),
      "staged payload parent",
      stableGuards,
      operations,
    );
    const copiedGuard = await copyFileExclusiveSafely({
      sourceRoot: PAYLOAD_ROOT,
      source: file.absolute,
      destinationRoot: targets.root,
      destination,
      label: `staged payload file ${file.relative}`,
      stableGuards,
      operations,
    });
    await chmodSafely(copiedGuard, file.mode, stableGuards, operations);
  }
}

function recoveryErrorForPathChange(error, paths, plan) {
  return new CliError(error.message, {
    exitCode: error.exitCode ?? 3,
    code: "path_identity_changed",
    details: {
      ...error.details,
      recovery_path: paths.stateRoot,
      transaction_path: paths.transactionRoot,
      backup_path: plan.permanentBackup ? paths.backupRoot : null,
    },
  });
}

function recoveryErrorForCleanup(error, paths, plan) {
  return new CliError(
    "Transaction cleanup failed; recovery is required.",
    {
      exitCode: 1,
      code: "cleanup_failed",
      details: {
        cause_code: error?.code ?? null,
        recovery_path: paths.stateRoot,
        transaction_path: paths.transactionRoot,
        backup_path: plan.permanentBackup ? paths.backupRoot : null,
      },
    },
  );
}

export async function installCommand(options, runtime = {}) {
  const operations = filesystemOperations(runtime);
  let targets = await resolveTargets(options, runtime, {
    checkAdapterSafety: !options.noReviewAdapter,
  });
  await assertNoIncompleteTransaction(targets);
  const payload = await validatePayload();
  const desiredAdapter = options.noReviewAdapter
    ? null
    : await renderReviewAdapter(targets, runtime.platform ?? process.platform);
  let plan = await classifyInstall(targets, payload, desiredAdapter, options);
  const initialTargets = targets;
  const rootGuard = await capturePathGuard(
    targets.root,
    targets.root,
    "selected installation root",
  );
  const coreGuard = await capturePathGuard(
    targets.root,
    targets.core,
    "core Skill destination",
  );
  const touchesAdapter = Boolean(
    desiredAdapter || plan.current.marker?.review_adapter,
  );
  const initialAdapterGuard = touchesAdapter
    ? await capturePathGuard(
        targets.root,
        targets.adapter,
        "review adapter destination",
      )
    : null;
  const initialTargetGuards = [rootGuard, coreGuard, initialAdapterGuard];
  const operationId = randomUUID();
  const previewPaths = await statePaths(targets, operationId);
  const previewActions = installActions(
    plan,
    targets,
    desiredAdapter,
    previewPaths.backupRoot,
  );

  if (plan.mode === "noop" || options.dryRun) {
    return resultEnvelope(
      "install",
      options,
      previewActions,
      preservedAdapterWarnings(plan, targets),
    );
  }

  const paths = previewPaths;
  const installed = [];
  const moved = [];
  let committed = false;
  let preserveRecovery = false;
  let transactionStarted = false;

  try {
    transactionStarted = true;
    await initializeTransactionState(
      paths,
      targets,
      paths.stagedCore,
      initialTargetGuards,
      operations,
    );
    const operationGuards = [rootGuard, paths.transactionGuard];
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    await copyPayloadSafely(
      payload,
      paths.stagedCore,
      targets,
      [...initialTargetGuards, ...operationGuards],
      operations,
    );
    const ownership = buildOwnershipRecord(targets, payload, desiredAdapter);
    await writeFileExclusiveSafely({
      root: targets.root,
      destination: path.join(paths.stagedCore, OWNERSHIP_FILE),
      content: `${JSON.stringify(ownership, null, 2)}\n`,
      label: "staged ownership record",
      stableGuards: [...initialTargetGuards, ...operationGuards],
      operations,
    });
    let stagedAdapterGuard = null;
    if (desiredAdapter) {
      await createDirectorySafely(
        targets,
        path.dirname(paths.stagedAdapter),
        "staged review adapter parent",
        operationGuards,
        operations,
      );
      stagedAdapterGuard = await writeFileExclusiveSafely({
        root: targets.root,
        destination: paths.stagedAdapter,
        content: desiredAdapter.content,
        label: "staged review adapter",
        stableGuards: [...initialTargetGuards, ...operationGuards],
        operations,
      });
    }
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    await verifyStagedCore(paths.stagedCore, payload, targets);
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    const stagedCoreGuard = await capturePathGuard(
      targets.root,
      paths.stagedCore,
      "staged core Skill",
    );
    await chmodSafely(
      stagedCoreGuard,
      0o755,
      [...initialTargetGuards, ...operationGuards],
      operations,
    );
    if (
      desiredAdapter &&
      (await hashGuardedFile(
        stagedAdapterGuard,
        [...initialTargetGuards, ...operationGuards],
      )) !== desiredAdapter.sha256
    ) {
      throw safetyError("staged review adapter hash mismatch");
    }

    await assertGuards([...initialTargetGuards, ...operationGuards]);
    const refreshedTargets = await resolveTargets(options, runtime, {
      checkAdapterSafety: !options.noReviewAdapter,
    });
    assertSameTargets(initialTargets, refreshedTargets);
    targets = refreshedTargets;
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    plan = await classifyInstall(targets, payload, desiredAdapter, options);
    if (plan.mode === "noop") {
      return resultEnvelope(
        "install",
        options,
        installActions(plan, targets, desiredAdapter),
      );
    }

    const storageRoot = plan.permanentBackup
      ? paths.backupRoot
      : paths.previousRoot;
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    for (const item of plan.existing) {
      await moveTarget(
        item,
        storageRoot,
        targets,
        moved,
        operationGuards,
        paths,
        operations,
      );
    }
    await verifyMovedSnapshot(plan, storageRoot, targets);

    await createDirectorySafely(
      targets,
      path.dirname(targets.core),
      "core Skill parent",
      operationGuards,
      operations,
    );
    const installedCoreGuard = await commitStagedCore(
      paths.stagedCore,
      targets.core,
      targets,
      operationGuards,
      operations,
    );
    installed.push(installedCoreGuard);

    if (desiredAdapter) {
      await createDirectorySafely(
        targets,
        path.dirname(targets.adapter),
        "review adapter parent",
        operationGuards,
        operations,
      );
      const installedAdapterGuard = await commitStagedAdapter(
        paths.stagedAdapter,
        targets.adapter,
        targets,
        operationGuards,
        operations,
      );
      installed.push(installedAdapterGuard);
      await chmodSafely(
        installedAdapterGuard,
        0o644,
        operationGuards,
        operations,
      );
      if (
        (await hashGuardedFile(
          installedAdapterGuard,
          operationGuards,
        )) !== desiredAdapter.sha256
      ) {
        throw safetyError("committed review adapter hash mismatch");
      }
    }

    committed = true;
    const warnings = preservedAdapterWarnings(plan, targets);
    try {
      await cleanupState(paths, operations, {
        keepBackup: plan.permanentBackup,
      });
    } catch (error) {
      preserveRecovery = true;
      throw recoveryErrorForCleanup(error, paths, plan);
    }
    return resultEnvelope(
      "install",
      options,
      installActions(
        plan,
        targets,
        desiredAdapter,
        plan.permanentBackup ? paths.backupRoot : null,
      ),
      warnings,
    );
  } catch (error) {
    if (committed) {
      preserveRecovery = true;
      throw error;
    }
    if (requiresRecovery(error) && transactionStarted) {
      preserveRecovery = true;
      throw recoveryErrorForPathChange(error, paths, plan);
    }
    if (installed.length > 0 || moved.length > 0) {
      try {
        await rollbackTransaction(
          installed,
          moved,
          [rootGuard, paths.transactionGuard],
          operations,
        );
      } catch (rollbackError) {
        preserveRecovery = true;
        throw new CliError(
          `${error.message}; ${rollbackError.message}`,
          {
            exitCode: 1,
            code: "rollback_failed",
            details: {
              recovery_path: paths.stateRoot,
              transaction_path: paths.transactionRoot,
              backup_path: plan.permanentBackup
                ? paths.backupRoot
                : null,
            },
          },
        );
      }
    }
    throw error;
  } finally {
    if (!committed && !preserveRecovery) {
      try {
        await cleanupState(paths, operations);
      } catch (cleanupError) {
        if (requiresRecovery(cleanupError)) {
          preserveRecovery = true;
          throw recoveryErrorForPathChange(cleanupError, paths, plan);
        }
        preserveRecovery = true;
        throw recoveryErrorForCleanup(cleanupError, paths, plan);
      }
    }
  }
}

async function classifyUninstall(targets, options) {
  const current = await inspectInstallation(targets);
  const touchesAdapter = Boolean(
    current.owned && current.marker?.review_adapter,
  );
  if (touchesAdapter) {
    await assertSafeDestination(
      targets.root,
      targets.adapter,
      "review adapter destination",
    );
  }
  const adapter = await adapterMetadata(targets, {
    rejectSymlink: touchesAdapter || !current.exists,
  });

  if (!current.exists) {
    if (adapter) {
      throw conflictError(
        "review adapter exists without a valid core ownership record",
        {
          conflicts: [{ type: "orphan_adapter", path: targets.adapter }],
        },
      );
    }
    return {
      current,
      existing: [],
      mode: "noop",
      permanentBackup: false,
    };
  }
  if (!current.owned) {
    throw conflictError(
      "uninstall requires a valid package ownership record",
      conflictDetails([
        {
          type: "invalid_ownership",
          path: targets.core,
          issues: current.issues,
        },
      ]),
    );
  }
  if (!current.unchanged && !options.force) {
    throw conflictError(
      "managed files changed; pass --force to back them up before uninstalling",
      conflictDetails([
        {
          type: "modified_installation",
          path: targets.core,
          issues: current.issues,
        },
      ]),
    );
  }

  const existing = [
    {
      kind: "core",
      path: targets.core,
      relative: targets.coreRelative,
    },
  ];
  if (current.marker.review_adapter && adapter) {
    existing.push({
      kind: "adapter",
      path: targets.adapter,
      relative: targets.adapterRelative,
    });
  }
  return {
    current,
    existing,
    mode: "uninstall",
    permanentBackup: Boolean(options.force && !current.unchanged),
    unmanagedAdapterPreserved: Boolean(
      !touchesAdapter && adapter,
    ),
  };
}

function uninstallActions(plan, backupRoot = null) {
  if (plan.mode === "noop") {
    return [
      {
        type: "noop",
        message: "No managed installation was found.",
      },
    ];
  }
  if (plan.permanentBackup) {
    return plan.existing.map((item) => ({
      type: "backup_and_remove",
      path: item.path,
      destination: targetFromRelative(
        backupRoot,
        backupRelative(item.relative),
      ),
    }));
  }
  return plan.existing.map((item) => ({
    type: "remove",
    path: item.path,
  }));
}

export async function uninstallCommand(options, runtime = {}) {
  const operations = filesystemOperations(runtime);
  let targets = await resolveTargets(options, runtime, {
    checkDuplicates: false,
    checkAdapterSafety: false,
  });
  await assertNoIncompleteTransaction(targets);
  let plan = await classifyUninstall(targets, options);
  const initialTargets = targets;
  const rootGuard = await capturePathGuard(
    targets.root,
    targets.root,
    "selected installation root",
  );
  const coreGuard = await capturePathGuard(
    targets.root,
    targets.core,
    "core Skill destination",
  );
  const initialAdapterGuard = plan.existing.some(
    (item) => item.kind === "adapter",
  )
    ? await capturePathGuard(
        targets.root,
        targets.adapter,
        "review adapter destination",
      )
    : null;
  const initialTargetGuards = [rootGuard, coreGuard, initialAdapterGuard];
  const operationId = randomUUID();
  const paths = await statePaths(targets, operationId);
  const actions = uninstallActions(
    plan,
    plan.permanentBackup ? paths.backupRoot : null,
  );
  if (plan.mode === "noop" || options.dryRun) {
    return resultEnvelope(
      "uninstall",
      options,
      actions,
      preservedAdapterWarnings(plan, targets),
    );
  }

  const moved = [];
  let committed = false;
  let preserveRecovery = false;
  let transactionStarted = false;
  try {
    transactionStarted = true;
    await initializeTransactionState(
      paths,
      targets,
      paths.transactionRoot,
      initialTargetGuards,
      operations,
    );
    const operationGuards = [rootGuard, paths.transactionGuard];
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    const refreshedTargets = await resolveTargets(options, runtime, {
      checkDuplicates: false,
      checkAdapterSafety: false,
    });
    assertSameTargets(initialTargets, refreshedTargets);
    targets = refreshedTargets;
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    plan = await classifyUninstall(targets, options);
    if (plan.mode === "noop") {
      return resultEnvelope("uninstall", options, uninstallActions(plan));
    }

    const storageRoot = plan.permanentBackup
      ? paths.backupRoot
      : paths.previousRoot;
    await assertGuards([...initialTargetGuards, ...operationGuards]);
    for (const item of plan.existing) {
      await moveTarget(
        item,
        storageRoot,
        targets,
        moved,
        operationGuards,
        paths,
        operations,
      );
    }
    await verifyMovedSnapshot(plan, storageRoot, targets);
    committed = true;

    const warnings = preservedAdapterWarnings(plan, targets);
    try {
      await cleanupState(paths, operations, {
        keepBackup: plan.permanentBackup,
      });
    } catch (error) {
      preserveRecovery = true;
      throw recoveryErrorForCleanup(error, paths, plan);
    }
    return resultEnvelope(
      "uninstall",
      options,
      uninstallActions(
        plan,
        plan.permanentBackup ? paths.backupRoot : null,
      ),
      warnings,
    );
  } catch (error) {
    if (committed) {
      preserveRecovery = true;
      throw error;
    }
    if (requiresRecovery(error) && transactionStarted) {
      preserveRecovery = true;
      throw recoveryErrorForPathChange(error, paths, plan);
    }
    if (moved.length > 0) {
      try {
        await rollbackTransaction(
          [],
          moved,
          [rootGuard, paths.transactionGuard],
          operations,
        );
      } catch (rollbackError) {
        preserveRecovery = true;
        throw new CliError(
          `${error.message}; ${rollbackError.message}`,
          {
            exitCode: 1,
            code: "rollback_failed",
            details: {
              recovery_path: paths.stateRoot,
              transaction_path: paths.transactionRoot,
              backup_path: plan.permanentBackup
                ? paths.backupRoot
                : null,
            },
          },
        );
      }
    }
    throw error;
  } finally {
    if (!committed && !preserveRecovery) {
      try {
        await cleanupState(paths, operations);
      } catch (cleanupError) {
        if (requiresRecovery(cleanupError)) {
          preserveRecovery = true;
          throw recoveryErrorForPathChange(cleanupError, paths, plan);
        }
        preserveRecovery = true;
        throw recoveryErrorForCleanup(cleanupError, paths, plan);
      }
    }
  }
}
