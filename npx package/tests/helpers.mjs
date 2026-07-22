import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HOSTS } from "../lib/config.mjs";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function temporaryRoot(t, prefix = "lfuxd-test-") {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await fs.realpath(created);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

export function commandOptions(
  command,
  host,
  root,
  overrides = {},
) {
  const scope = overrides.scope ?? "project";
  return {
    command,
    host,
    scope,
    projectRoot: scope === "project" ? root : undefined,
    projectRootProvided: scope === "project",
    noReviewAdapter: false,
    dryRun: false,
    json: true,
    force: false,
    ...overrides,
  };
}

export function memoryStream() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

export async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

export function collectStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, output);
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, output);
    }
  }
  return output;
}

export async function fakeDoctorRuntime(t, root, host, overrides = {}) {
  const bin = path.join(root, "fake-bin");
  await fs.mkdir(bin, { recursive: true });
  const windows = process.platform === "win32";
  const extension = windows ? ".CMD" : "";
  const executableNames = [
    windows ? `py${extension}` : "python3",
    `${HOSTS[host].cli}${extension}`,
  ];
  for (const name of executableNames) {
    const executable = path.join(bin, name);
    await fs.writeFile(executable, windows ? "@exit /b 0\r\n" : "#!/bin/sh\n");
    if (!windows) {
      await fs.chmod(executable, 0o755);
    }
  }

  const spawnCalls = [];
  const runtime = {
    env: {
      PATH: bin,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
    platform: process.platform,
    spawnSync(executable, arguments_, options) {
      spawnCalls.push({ executable, arguments_, options });
      return {
        status: 0,
        stdout: "Python 3.11.9\n",
        stderr: "",
      };
    },
    ...overrides,
  };
  t.after(() => {
    for (const call of spawnCalls) {
      assert.equal(call.options.shell, false);
    }
  });
  return { runtime, spawnCalls };
}

export function expectedPaths(root, host, scope = "project") {
  return {
    core: path.join(root, ...HOSTS[host].core[scope]),
    adapter: path.join(root, ...HOSTS[host].adapter[scope]),
  };
}

export async function relativeInventory(root) {
  const output = [];

  async function walk(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.join(prefix, entry.name).split(path.sep).join("/");
      if (entry.isDirectory()) {
        output.push(`d:${relative}`);
        await walk(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        output.push(`l:${relative}:${await fs.readlink(absolute)}`);
      } else {
        const content = await fs.readFile(absolute);
        output.push(`f:${relative}:${content.toString("base64")}`);
      }
    }
  }

  await walk(root);
  return output;
}
