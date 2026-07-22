import { promises as fs } from "node:fs";
import path from "node:path";

import {
  OWNERSHIP_FILE,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PAYLOAD_ROOT,
  SKILL_NAME,
} from "./config.mjs";
import { safetyError } from "./errors.mjs";
import {
  expectedDirectories,
  hashFile,
  lstatOrNull,
  nativeRelativePath,
  readJson,
  scanTree,
  sha256,
} from "./fs-utils.mjs";

const ALLOWED_PAYLOAD_ROOTS = new Set([
  "SKILL.md",
  "LICENSE",
  "agents",
  "assets",
  "references",
  "scripts",
]);

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw safetyError("packaged SKILL.md has invalid frontmatter");
  }
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    fields.set(key, value);
  }
  return fields;
}

function validateSkillFrontmatter(text, label) {
  const frontmatter = parseFrontmatter(text);
  if (frontmatter.get("name") !== SKILL_NAME) {
    throw safetyError(`${label} Skill name must be ${SKILL_NAME}`);
  }
  const description = frontmatter.get("description") ?? "";
  if (description.length < 1 || description.length > 1024) {
    throw safetyError(`${label} Skill description must contain 1-1024 characters`);
  }
}

export async function validateInstalledSkill(skillRoot) {
  const skillText = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  validateSkillFrontmatter(skillText, "installed");
}

export async function validatePayload() {
  const scan = await scanTree(PAYLOAD_ROOT);
  if (scan.files.length === 0) {
    throw safetyError("packaged Skill payload is empty");
  }

  for (const entry of [...scan.files, ...scan.directories.map((relative) => ({ relative }))]) {
    const rootName = entry.relative.split("/")[0];
    if (!ALLOWED_PAYLOAD_ROOTS.has(rootName)) {
      throw safetyError(`unexpected packaged Skill entry: ${entry.relative}`);
    }
  }

  const requiredFiles = ["SKILL.md", "LICENSE"];
  const fileNames = new Set(scan.files.map((file) => file.relative));
  for (const required of requiredFiles) {
    if (!fileNames.has(required)) {
      throw safetyError(`packaged Skill is missing ${required}`);
    }
  }
  for (const requiredDirectory of ["agents", "assets", "references", "scripts"]) {
    if (!scan.directories.includes(requiredDirectory)) {
      throw safetyError(`packaged Skill is missing ${requiredDirectory}/`);
    }
  }

  const skillText = await fs.readFile(path.join(PAYLOAD_ROOT, "SKILL.md"), "utf8");
  validateSkillFrontmatter(skillText, "packaged");

  return scan;
}

function quoteCommandArgument(value, platform) {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function renderReviewAdapter(targets, platform = process.platform) {
  const templatePath = path.join(
    PAYLOAD_ROOT,
    ...targets.adapterTemplateRelative,
  );
  let template = await fs.readFile(templatePath, "utf8");
  const rootPlaceholder =
    targets.scope === "user" ? "<user-home>" : "<project-root>";
  const portableSkillRoot = `${rootPlaceholder}/${targets.coreRelative}`;
  const scriptPath = `${portableSkillRoot}/scripts/board_package.py`;
  const quotedScript = quoteCommandArgument(scriptPath, platform);
  const quotedRoot = quoteCommandArgument(portableSkillRoot, platform);

  template = template.replaceAll(
    "<skill-root>/scripts/board_package.py",
    quotedScript,
  );
  template = template.replaceAll("<skill-root>", quotedRoot);
  if (platform === "win32") {
    template = template.replaceAll(`python3 ${quotedScript}`, `py -3 ${quotedScript}`);
  }
  if (template.includes("<skill-root>")) {
    throw safetyError("review adapter contains an unresolved Skill path");
  }
  if (!template.endsWith("\n")) {
    template += "\n";
  }
  return {
    content: template,
    sha256: sha256(Buffer.from(template, "utf8")),
  };
}

export function buildOwnershipRecord(targets, payload, reviewAdapter) {
  return {
    schema_version: "1.0",
    package_name: PACKAGE_NAME,
    package_version: PACKAGE_VERSION,
    skill_name: SKILL_NAME,
    host: targets.host,
    scope: targets.scope,
    owned_files: payload.files.map((file) => ({
      path: file.relative,
      sha256: file.sha256,
    })),
    review_adapter: reviewAdapter
      ? {
          path: targets.adapterRelative,
          sha256: reviewAdapter.sha256,
        }
      : null,
  };
}

function validateHash(hash, label) {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw safetyError(`invalid SHA-256 in ownership record: ${label}`);
  }
}

export function validateOwnershipRecord(record, targets) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw safetyError("ownership record must be a JSON object");
  }
  const expected = {
    schema_version: "1.0",
    package_name: PACKAGE_NAME,
    skill_name: SKILL_NAME,
    host: targets.host,
    scope: targets.scope,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      throw safetyError(`ownership record ${key} does not match this installation`);
    }
  }
  if (
    typeof record.package_version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      record.package_version,
    )
  ) {
    throw safetyError("ownership record package_version is invalid");
  }
  if (!Array.isArray(record.owned_files) || record.owned_files.length === 0) {
    throw safetyError("ownership record owned_files is invalid");
  }

  const seen = new Set();
  const seenCaseFolded = new Set();
  const ownedFiles = record.owned_files.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw safetyError("ownership record contains an invalid file entry");
    }
    const relative = entry.path;
    nativeRelativePath(relative);
    const caseFolded = relative.toLocaleLowerCase("en-US");
    if (
      relative === OWNERSHIP_FILE ||
      seen.has(relative) ||
      seenCaseFolded.has(caseFolded)
    ) {
      throw safetyError(`ownership record contains an unsafe file entry: ${relative}`);
    }
    validateHash(entry.sha256, relative);
    seen.add(relative);
    seenCaseFolded.add(caseFolded);
    return {
      path: relative,
      sha256: entry.sha256,
    };
  });

  let reviewAdapter = null;
  if (record.review_adapter !== null) {
    const entry = record.review_adapter;
    if (!entry || typeof entry !== "object") {
      throw safetyError("ownership record review_adapter is invalid");
    }
    nativeRelativePath(entry.path);
    if (entry.path !== targets.adapterRelative) {
      throw safetyError("ownership record review adapter path does not match the host");
    }
    validateHash(entry.sha256, entry.path);
    reviewAdapter = {
      path: entry.path,
      sha256: entry.sha256,
    };
  }

  return {
    ...record,
    owned_files: ownedFiles,
    review_adapter: reviewAdapter,
  };
}

function compareSets(actual, expected, prefix, issues) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const name of expectedSet) {
    if (!actualSet.has(name)) {
      issues.push(`${prefix} missing: ${name}`);
    }
  }
  for (const name of actualSet) {
    if (!expectedSet.has(name)) {
      issues.push(`${prefix} unexpected: ${name}`);
    }
  }
}

export async function inspectInstallation(targets) {
  const coreMetadata = await lstatOrNull(targets.core);
  if (!coreMetadata) {
    return {
      exists: false,
      owned: false,
      unchanged: false,
      marker: null,
      issues: [],
    };
  }
  if (coreMetadata.isSymbolicLink() || !coreMetadata.isDirectory()) {
    return {
      exists: true,
      owned: false,
      unchanged: false,
      marker: null,
      issues: ["core Skill destination is not a managed directory"],
    };
  }

  const markerPath = path.join(targets.core, OWNERSHIP_FILE);
  let rawMarker;
  try {
    rawMarker = await readJson(markerPath);
  } catch (error) {
    return {
      exists: true,
      owned: false,
      unchanged: false,
      marker: null,
      issues: [error.message],
    };
  }
  if (!rawMarker) {
    return {
      exists: true,
      owned: false,
      unchanged: false,
      marker: null,
      issues: ["ownership record is missing"],
    };
  }

  let marker;
  try {
    marker = validateOwnershipRecord(rawMarker, targets);
  } catch (error) {
    return {
      exists: true,
      owned: false,
      unchanged: false,
      marker: null,
      issues: [error.message],
    };
  }

  const issues = [];
  let actual;
  try {
    actual = await scanTree(targets.core, {
      exclude: new Set([OWNERSHIP_FILE]),
      hashFiles: false,
    });
  } catch (error) {
    issues.push(error.message);
    return {
      exists: true,
      owned: true,
      unchanged: false,
      marker,
      issues,
    };
  }

  const expectedFiles = marker.owned_files.map((entry) => entry.path).sort();
  const actualFiles = actual.files.map((entry) => entry.relative).sort();
  compareSets(actualFiles, expectedFiles, "owned file", issues);

  const expectedDirectoryNames = expectedDirectories(
    marker.owned_files.map((entry) => ({ relative: entry.path })),
  );
  compareSets(actual.directories, expectedDirectoryNames, "owned directory", issues);

  const expectedHashes = new Map(
    marker.owned_files.map((entry) => [entry.path, entry.sha256]),
  );
  for (const file of actual.files) {
    const expectedHash = expectedHashes.get(file.relative);
    if (expectedHash) {
      try {
        if ((await hashFile(file.absolute)) !== expectedHash) {
          issues.push(`owned file changed: ${file.relative}`);
        }
      } catch {
        issues.push(`owned file could not be verified: ${file.relative}`);
      }
    }
  }

  if (marker.review_adapter) {
    const adapterMetadata = await lstatOrNull(targets.adapter);
    if (!adapterMetadata) {
      issues.push("review adapter is missing");
    } else if (adapterMetadata.isSymbolicLink() || !adapterMetadata.isFile()) {
      issues.push("review adapter is not a managed regular file");
    } else {
      try {
        if (
          (await hashFile(targets.adapter)) !== marker.review_adapter.sha256
        ) {
          issues.push("review adapter changed");
        }
      } catch {
        issues.push("review adapter could not be verified");
      }
    }
  }

  return {
    exists: true,
    owned: true,
    unchanged: issues.length === 0,
    marker,
    issues,
  };
}

export function desiredMatches(marker, payload, reviewAdapter) {
  if (
    !marker ||
    marker.package_version !== PACKAGE_VERSION ||
    !payloadMatches(marker, payload)
  ) {
    return false;
  }
  if (!reviewAdapter) {
    return marker.review_adapter === null;
  }
  return marker.review_adapter?.sha256 === reviewAdapter.sha256;
}

export function payloadMatches(marker, payload) {
  if (!marker) {
    return false;
  }
  const desiredFiles = new Map(
    payload.files.map((entry) => [entry.relative, entry.sha256]),
  );
  if (desiredFiles.size !== marker.owned_files.length) {
    return false;
  }
  for (const entry of marker.owned_files) {
    if (desiredFiles.get(entry.path) !== entry.sha256) {
      return false;
    }
  }
  return true;
}
