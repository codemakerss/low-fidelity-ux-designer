import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

import { safetyError } from "./errors.mjs";

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(filePath) {
  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw safetyError(`file changed into a symbolic link while hashing: ${filePath}`);
    }
    throw error;
  }

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw safetyError(`managed path is not a regular file: ${filePath}`);
    }
    const expectedSize = metadata.size;
    while (position < expectedSize) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position,
      );
      if (bytesRead === 0) {
        throw safetyError(`managed file changed while hashing: ${filePath}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if ((await handle.stat()).size !== expectedSize) {
      throw safetyError(`managed file changed while hashing: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

export async function pathExists(filePath) {
  return (await lstatOrNull(filePath)) !== null;
}

export function portablePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function containsControlCharacters(value) {
  return /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
    value,
  );
}

export function nativeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    containsControlCharacters(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw safetyError("invalid recorded relative path");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw safetyError(`unsafe recorded relative path: ${relativePath}`);
  }
  const native = path.join(...segments);
  if (path.isAbsolute(native)) {
    throw safetyError(`absolute recorded path is not allowed: ${relativePath}`);
  }
  return native;
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function canonicalDirectory(directory, label) {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    containsControlCharacters(directory)
  ) {
    throw safetyError(`${label} contains unsupported control characters`);
  }
  const metadata = await lstatOrNull(directory);
  if (!metadata) {
    throw safetyError(`${label} does not exist: ${directory}`);
  }
  let resolved;
  try {
    resolved = await fs.realpath(directory);
  } catch {
    throw safetyError(`${label} cannot be resolved: ${directory}`);
  }
  const resolvedMetadata = await fs.stat(resolved);
  if (!resolvedMetadata.isDirectory()) {
    throw safetyError(`${label} is not a directory: ${directory}`);
  }
  return resolved;
}

async function deepestExistingAncestor(target) {
  const missing = [];
  let cursor = target;
  while (true) {
    const metadata = await lstatOrNull(cursor);
    if (metadata) {
      return { ancestor: cursor, metadata, missing: missing.reverse() };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw safetyError(`cannot resolve destination ancestor: ${target}`);
    }
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

export async function assertSafeDestination(root, target, label) {
  const lexicalTarget = path.resolve(target);
  if (!isWithin(root, lexicalTarget)) {
    throw safetyError(`${label} escapes the selected root`, {
      path: lexicalTarget,
    });
  }

  const exactMetadata = await lstatOrNull(lexicalTarget);
  if (exactMetadata?.isSymbolicLink()) {
    throw safetyError(`${label} must not be a symbolic link`, {
      path: lexicalTarget,
    });
  }

  const { ancestor, metadata, missing } =
    await deepestExistingAncestor(lexicalTarget);
  if (missing.length > 0 && !metadata.isDirectory()) {
    throw safetyError(`${label} has a non-directory ancestor`, {
      path: ancestor,
    });
  }
  const realAncestor = await fs.realpath(ancestor);
  const resolvedTarget = path.resolve(realAncestor, ...missing);
  if (!isWithin(root, resolvedTarget)) {
    throw safetyError(`${label} resolves outside the selected root`, {
      path: lexicalTarget,
    });
  }
  return lexicalTarget;
}

function metadataKind(metadata) {
  if (metadata.isDirectory()) {
    return "directory";
  }
  if (metadata.isFile()) {
    return "file";
  }
  if (metadata.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function identityMatches(entry, metadata) {
  return (
    entry.dev === metadata.dev &&
    entry.ino === metadata.ino &&
    entry.kind === metadataKind(metadata)
  );
}

export async function capturePathGuard(root, target, label) {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  if (!isWithin(lexicalRoot, lexicalTarget)) {
    throw safetyError(`${label} escapes the selected root`, {
      path: lexicalTarget,
    });
  }

  const relative = path.relative(lexicalRoot, lexicalTarget);
  const segments = relative === "" ? [] : relative.split(path.sep);
  const entries = [];
  const missing = [];
  let cursor = lexicalRoot;
  let parentMissing = false;

  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) {
      cursor = path.join(cursor, segments[index]);
    }
    if (parentMissing) {
      missing.push(cursor);
      continue;
    }

    const metadata = await lstatOrNull(cursor);
    if (!metadata) {
      parentMissing = true;
      missing.push(cursor);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      throw safetyError(`${label} must not traverse a symbolic link`, {
        path: cursor,
      });
    }
    const isTarget = cursor === lexicalTarget;
    if (!isTarget && !metadata.isDirectory()) {
      throw safetyError(`${label} has a non-directory ancestor`, {
        path: cursor,
      });
    }
    if (metadata.isDirectory()) {
      const resolved = await fs.realpath(cursor);
      if (!isWithin(lexicalRoot, resolved)) {
        throw safetyError(`${label} resolves outside the selected root`, {
          path: cursor,
        });
      }
    }
    entries.push({
      path: cursor,
      dev: metadata.dev,
      ino: metadata.ino,
      kind: metadataKind(metadata),
    });
  }

  return {
    root: lexicalRoot,
    target: lexicalTarget,
    label,
    entries,
    missing,
  };
}

export async function assertPathGuard(guard) {
  for (const entry of guard.entries) {
    const metadata = await lstatOrNull(entry.path);
    if (
      !metadata ||
      metadata.isSymbolicLink() ||
      !identityMatches(entry, metadata)
    ) {
      throw safetyError(`${guard.label} changed during the operation`, {
        path: entry.path,
        reason: "path_identity_changed",
      });
    }
    if (metadata.isDirectory()) {
      const resolved = await fs.realpath(entry.path);
      if (!isWithin(guard.root, resolved)) {
        throw safetyError(
          `${guard.label} changed to resolve outside the selected root`,
          {
            path: entry.path,
            reason: "path_identity_changed",
          },
        );
      }
    }
  }
  for (const missingPath of guard.missing) {
    if (await lstatOrNull(missingPath)) {
      throw safetyError(`${guard.label} changed during the operation`, {
        path: missingPath,
        reason: "path_identity_changed",
      });
    }
  }
  return guard.target;
}

export function guardedEntry(guard) {
  return guard.entries.find((entry) => entry.path === guard.target) ?? null;
}

export async function inspectTransactionState(root, stateDirectory) {
  const stateRoot = await assertSafeDestination(
    root,
    path.join(root, stateDirectory),
    "CLI state directory",
  );
  const transactions = await assertSafeDestination(
    root,
    path.join(stateRoot, "transactions"),
    "transaction state directory",
  );
  const metadata = await lstatOrNull(transactions);
  if (!metadata) {
    return {
      path: transactions,
      incomplete: false,
    };
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw safetyError("transaction state path is not a managed directory", {
      path: transactions,
    });
  }
  return {
    path: transactions,
    incomplete: (await fs.readdir(transactions)).length > 0,
  };
}

export async function scanTree(
  root,
  { exclude = new Set(), hashFiles = true } = {},
) {
  const files = [];
  const directories = [];
  const rootMetadata = await lstatOrNull(root);
  if (!rootMetadata) {
    return { files, directories };
  }
  if (rootMetadata.isSymbolicLink()) {
    throw safetyError(`tree root must not be a symbolic link: ${root}`);
  }
  if (!rootMetadata.isDirectory()) {
    throw safetyError(`tree root is not a directory: ${root}`);
  }

  async function walk(directory, prefix = "") {
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = portablePath(path.join(prefix, name));
      if (containsControlCharacters(relative)) {
        throw safetyError(
          "managed content contains a filename with unsupported control characters",
        );
      }
      if (exclude.has(relative)) {
        continue;
      }
      const metadata = await fs.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw safetyError(`symbolic link is not allowed in managed content: ${relative}`);
      }
      if (metadata.isDirectory()) {
        directories.push(relative);
        await walk(absolute, relative);
      } else if (metadata.isFile()) {
        files.push({
          absolute,
          relative,
          mode: metadata.mode & 0o777,
          size: metadata.size,
          sha256: hashFiles ? await hashFile(absolute) : null,
        });
      } else {
        throw safetyError(`unsupported managed entry: ${relative}`);
      }
    }
  }

  await walk(root);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  directories.sort();
  return { files, directories };
}

export function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const segments = file.relative.split("/");
    segments.pop();
    while (segments.length > 0) {
      directories.add(segments.join("/"));
      segments.pop();
    }
  }
  return [...directories].sort();
}

export async function readJson(filePath, { maxBytes = 1024 * 1024 } = {}) {
  const metadata = await lstatOrNull(filePath);
  if (!metadata) {
    return null;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw safetyError(`JSON path is not a regular file: ${filePath}`);
  }
  if (metadata.size > maxBytes) {
    throw safetyError(`JSON file exceeds the ${maxBytes}-byte safety limit: ${filePath}`);
  }

  let handle;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error.code === "ELOOP") {
      throw safetyError(`JSON path changed into a symbolic link: ${filePath}`);
    }
    throw error;
  }

  let content;
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile()) {
      throw safetyError(`JSON path is not a regular file: ${filePath}`);
    }
    if (
      metadata.dev !== openedMetadata.dev ||
      metadata.ino !== openedMetadata.ino
    ) {
      throw safetyError(`JSON path changed while it was being opened: ${filePath}`);
    }
    if (openedMetadata.size > maxBytes) {
      throw safetyError(`JSON file exceeds the ${maxBytes}-byte safety limit: ${filePath}`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let position = 0;
    while (position <= maxBytes) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes + 1 - position),
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (position > maxBytes) {
      throw safetyError(`JSON file exceeds the ${maxBytes}-byte safety limit: ${filePath}`);
    }
    content = Buffer.concat(chunks, position);
  } finally {
    await handle.close();
  }
  const text = content.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw safetyError(`invalid JSON file: ${filePath}`);
  }
}
