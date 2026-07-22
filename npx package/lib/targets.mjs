import os from "node:os";
import path from "node:path";

import { HOST_NAMES, HOSTS, SCOPES, SKILL_NAME } from "./config.mjs";
import { conflictError, usageError } from "./errors.mjs";
import {
  assertSafeDestination,
  canonicalDirectory,
  lstatOrNull,
  portablePath,
} from "./fs-utils.mjs";

function joinParts(root, parts) {
  return path.join(root, ...parts);
}

export async function resolveTargets(
  options,
  runtime = {},
  {
    checkDuplicates = true,
    checkAdapterSafety = true,
  } = {},
) {
  const host = options.host;
  const scope = options.scope ?? "project";
  if (!HOST_NAMES.includes(host)) {
    throw usageError(`unsupported host: ${String(host)}`);
  }
  if (!SCOPES.includes(scope)) {
    throw usageError(`unsupported scope: ${String(scope)}`);
  }
  if (scope === "user" && options.projectRootProvided) {
    throw usageError("--project-root cannot be used with --scope user");
  }

  const selectedRoot =
    scope === "project"
      ? path.resolve(options.projectRoot ?? runtime.cwd ?? process.cwd())
      : path.resolve(runtime.home ?? os.homedir());
  const root = await canonicalDirectory(
    selectedRoot,
    scope === "project" ? "project root" : "user home",
  );

  const hostConfig = HOSTS[host];
  const coreRelative = portablePath(path.join(...hostConfig.core[scope]));
  const adapterRelative = portablePath(path.join(...hostConfig.adapter[scope]));
  const core = await assertSafeDestination(
    root,
    joinParts(root, hostConfig.core[scope]),
    "core Skill destination",
  );
  const adapterPath = joinParts(root, hostConfig.adapter[scope]);
  const adapter = checkAdapterSafety
    ? await assertSafeDestination(
        root,
        adapterPath,
        "review adapter destination",
      )
    : path.resolve(adapterPath);

  const duplicates = [];
  for (const otherHost of HOST_NAMES) {
    if (otherHost === host) {
      continue;
    }
    const otherParts = HOSTS[otherHost].core[scope];
    const otherCore = joinParts(root, otherParts);
    const skillFile = path.join(otherCore, "SKILL.md");
    if (await lstatOrNull(skillFile)) {
      duplicates.push({
        host: otherHost,
        path: otherCore,
      });
    }
  }
  if (checkDuplicates && duplicates.length > 0) {
    throw conflictError(
      `the ${SKILL_NAME} Skill already exists in another supported discovery location`,
      { duplicates },
    );
  }

  return {
    host,
    scope,
    root,
    core,
    coreRelative,
    adapter,
    adapterRelative,
    hostCli: hostConfig.cli,
    adapterTemplateRelative: hostConfig.adapterTemplate,
    duplicates,
  };
}
