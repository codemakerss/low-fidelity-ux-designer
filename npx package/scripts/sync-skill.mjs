#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "..");
const SKILL_NAME = "low-fidelity-ux-designer";
const SKILL_PARENT = path.join(PACKAGE_ROOT, "skill");
const DESTINATION = path.join(SKILL_PARENT, SKILL_NAME);
const CHECK_ONLY = process.argv.slice(2).includes("--check");
const ALLOWED_ARGUMENTS = new Set(["--check"]);
const EXCLUDED_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".openai",
  "__pycache__",
  "node_modules",
]);

const SOURCES = [
  { source: path.join(REPOSITORY_ROOT, "SKILL.md"), destination: "SKILL.md" },
  { source: path.join(PACKAGE_ROOT, "LICENSE"), destination: "LICENSE" },
  { source: path.join(REPOSITORY_ROOT, "agents"), destination: "agents" },
  { source: path.join(REPOSITORY_ROOT, "assets"), destination: "assets" },
  { source: path.join(REPOSITORY_ROOT, "references"), destination: "references" },
  { source: path.join(REPOSITORY_ROOT, "scripts"), destination: "scripts" },
];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function portable(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function excluded(name) {
  return (
    EXCLUDED_NAMES.has(name) ||
    name.endsWith(".pyc") ||
    name.endsWith(".pyo") ||
    name.startsWith(".env")
  );
}

async function collectSource(source, destination, entries) {
  const metadata = await fs.lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`refusing to package symlink: ${destination}`);
  }
  if (metadata.isFile()) {
    const content = await fs.readFile(source);
    entries.push({
      source,
      destination: portable(destination),
      content,
      mode: metadata.mode & 0o777,
      sha256: digest(content),
    });
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`unsupported package entry: ${destination}`);
  }

  const names = (await fs.readdir(source)).sort();
  for (const name of names) {
    if (excluded(name)) {
      continue;
    }
    await collectSource(
      path.join(source, name),
      path.join(destination, name),
      entries,
    );
  }
}

async function expectedEntries() {
  const entries = [];
  for (const item of SOURCES) {
    await collectSource(item.source, item.destination, entries);
  }
  return entries.sort((left, right) =>
    left.destination.localeCompare(right.destination),
  );
}

async function actualEntries(root) {
  const entries = [];

  async function walk(directory, prefix = "") {
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = portable(path.join(prefix, name));
      const metadata = await fs.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`payload contains symlink: ${relative}`);
      }
      if (metadata.isDirectory()) {
        await walk(absolute, relative);
      } else if (metadata.isFile()) {
        const content = await fs.readFile(absolute);
        entries.push({
          destination: relative,
          sha256: digest(content),
        });
      } else {
        throw new Error(`payload contains unsupported entry: ${relative}`);
      }
    }
  }

  await walk(root);
  return entries;
}

function compare(expected, actual) {
  const expectedMap = new Map(
    expected.map((entry) => [entry.destination, entry.sha256]),
  );
  const actualMap = new Map(
    actual.map((entry) => [entry.destination, entry.sha256]),
  );
  const problems = [];

  for (const [name, hash] of expectedMap) {
    if (!actualMap.has(name)) {
      problems.push(`missing: ${name}`);
    } else if (actualMap.get(name) !== hash) {
      problems.push(`changed: ${name}`);
    }
  }
  for (const name of actualMap.keys()) {
    if (!expectedMap.has(name)) {
      problems.push(`unexpected: ${name}`);
    }
  }
  return problems;
}

async function writePayload(entries) {
  await fs.mkdir(SKILL_PARENT, { recursive: true });
  const operationId = randomUUID();
  const stagingRoot = path.join(SKILL_PARENT, `.sync-${operationId}`);
  const stagedSkill = path.join(stagingRoot, SKILL_NAME);
  const previous = path.join(SKILL_PARENT, `.previous-${operationId}`);
  let movedPrevious = false;

  await fs.mkdir(stagedSkill, { recursive: true });
  try {
    for (const entry of entries) {
      const destination = path.join(
        stagedSkill,
        ...entry.destination.split("/"),
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, entry.content, { mode: entry.mode });
      await fs.chmod(destination, entry.mode);
    }

    try {
      await fs.rename(DESTINATION, previous);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.rename(stagedSkill, DESTINATION);
    if (movedPrevious) {
      await fs.rm(previous, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      await fs.rm(DESTINATION, { recursive: true, force: true });
      if (movedPrevious) {
        await fs.rename(previous, DESTINATION);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "payload sync failed and rollback was incomplete",
      );
    }
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const unknown = process.argv.slice(2).filter((arg) => !ALLOWED_ARGUMENTS.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown argument: ${unknown[0]}`);
  }

  const expected = await expectedEntries();
  if (CHECK_ONLY) {
    let actual;
    try {
      actual = await actualEntries(DESTINATION);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("packaged Skill payload is missing; run npm run sync:skill");
      }
      throw error;
    }
    const problems = compare(expected, actual);
    if (problems.length > 0) {
      throw new Error(
        `packaged Skill payload is stale:\n${problems.join("\n")}`,
      );
    }
    console.log(`Skill payload is synchronized (${expected.length} files).`);
    return;
  }

  await writePayload(expected);
  console.log(`Synchronized Skill payload (${expected.length} files).`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
