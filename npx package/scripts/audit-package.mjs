import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { gunzipSync } from "node:zlib";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGE_JSON_PATH = path.join(PACKAGE_ROOT, "package.json");
const ALLOWED_PACK_ROOTS = new Set([
  "LICENSE",
  "README.md",
  "bin",
  "lib",
  "package.json",
  "skill",
]);
const PUBLISHED_DIRECTORIES = ["bin", "lib", "skill"];
const EXPECTED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "bin/low-fidelity-ux-designer.mjs",
  "lib/cli.mjs",
  "lib/config.mjs",
  "lib/doctor.mjs",
  "lib/errors.mjs",
  "lib/fs-utils.mjs",
  "lib/installer.mjs",
  "lib/managed-state.mjs",
  "lib/targets.mjs",
  "package.json",
  "skill/low-fidelity-ux-designer/LICENSE",
  "skill/low-fidelity-ux-designer/SKILL.md",
  "skill/low-fidelity-ux-designer/agents/openai.yaml",
  "skill/low-fidelity-ux-designer/assets/host-adapters/claude-code/SKILL.md",
  "skill/low-fidelity-ux-designer/assets/host-adapters/codex/SKILL.md",
  "skill/low-fidelity-ux-designer/assets/host-adapters/opencode/review-board.md",
  "skill/low-fidelity-ux-designer/assets/review-board/index.html",
  "skill/low-fidelity-ux-designer/references/board-storage.md",
  "skill/low-fidelity-ux-designer/references/discovery-playbook.md",
  "skill/low-fidelity-ux-designer/references/handoff-template.md",
  "skill/low-fidelity-ux-designer/references/host-adapters.md",
  "skill/low-fidelity-ux-designer/references/implementation-checklist.md",
  "skill/low-fidelity-ux-designer/references/link-intake.md",
  "skill/low-fidelity-ux-designer/references/rendering-lanes.md",
  "skill/low-fidelity-ux-designer/references/review-board.md",
  "skill/low-fidelity-ux-designer/references/wireframe-standards.md",
  "skill/low-fidelity-ux-designer/scripts/board_package.py",
  "skill/low-fidelity-ux-designer/scripts/board_registry.py",
  "skill/low-fidelity-ux-designer/scripts/install_host_adapters.py",
  "skill/low-fidelity-ux-designer/scripts/normalize_source.py",
  "skill/low-fidelity-ux-designer/scripts/review_bridge.py",
  "skill/low-fidelity-ux-designer/scripts/review_host_adapter.py",
  "skill/low-fidelity-ux-designer/scripts/validate_review_board.py",
]);
const HOST_NAMES = ["codex", "claude-code", "opencode"];
const SCOPES = ["project", "user"];
const LIFECYCLE_SCRIPTS = [
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
];
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];
const IDENTITY_FIELDS = [
  "author",
  "contributors",
  "maintainers",
  "repository",
  "homepage",
  "bugs",
  "funding",
];
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.invalid",
  "example.net",
  "example.org",
]);

function processFailure(label, result) {
  const details = [
    result.error?.message,
    result.stdout?.trim(),
    result.stderr?.trim(),
  ].filter(Boolean);
  return new Error(
    `${label} failed${details.length > 0 ? `: ${details.join("\n")}` : ""}`,
  );
}

function runProcess(
  executable,
  arguments_,
  {
    cwd = PACKAGE_ROOT,
    env = process.env,
    label = executable,
  } = {},
) {
  const result = spawnSync(executable, arguments_, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw processFailure(label, result);
  }
  return result;
}

function parseJsonOutput(result, label) {
  const output = result.stdout.trim();
  assert.notEqual(output, "", `${label} returned empty JSON output`);
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function isolatedBaseEnvironment(environment = process.env) {
  const isolated = {};
  const allowed = [
    "COMSPEC",
    "ComSpec",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "PATHEXT",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
    "windir",
  ];
  for (const key of allowed) {
    if (typeof environment[key] === "string") {
      isolated[key] = environment[key];
    }
  }
  return isolated;
}

function setIsolatedPath(environment, value) {
  delete environment.PATH;
  delete environment.Path;
  environment[process.platform === "win32" ? "Path" : "PATH"] = value;
}

async function createNpmEnvironment(temporaryRoot) {
  const home = path.join(temporaryRoot, "npm-home");
  const cache = path.join(temporaryRoot, "npm-cache");
  const prefix = path.join(temporaryRoot, "npm-prefix");
  const processTemp = path.join(temporaryRoot, "process-temp");
  const userConfig = path.join(temporaryRoot, "empty-user.npmrc");
  const globalConfig = path.join(temporaryRoot, "empty-global.npmrc");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(prefix, { recursive: true });
  await fs.mkdir(processTemp, { recursive: true });
  await fs.writeFile(userConfig, "", { mode: 0o600 });
  await fs.writeFile(globalConfig, "", { mode: 0o600 });
  const environment = {
    ...isolatedBaseEnvironment(),
    HOME: home,
    NO_COLOR: "1",
    TEMP: processTemp,
    TMP: processTemp,
    TMPDIR: processTemp,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(temporaryRoot, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(temporaryRoot, "xdg-config"),
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_LOGLEVEL: "error",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_PACKAGE_LOCK: "false",
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_PROVENANCE: "false",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
    NPM_CONFIG_SAVE: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: userConfig,
  };
  setIsolatedPath(environment, path.dirname(process.execPath));
  return environment;
}

function runNpm(arguments_, options = {}) {
  const npmCli = process.env.npm_execpath;
  assert.ok(
    npmCli,
    "npm_execpath is unavailable; run this audit with npm run audit:package",
  );
  return runProcess(
    process.execPath,
    [npmCli, ...arguments_],
    {
      ...options,
      label: options.label ?? `npm ${arguments_[0]}`,
    },
  );
}

function portablePath(relative) {
  return relative.split(path.sep).join("/");
}

function nativePackPath(root, relative) {
  assert.equal(typeof relative, "string");
  assert.notEqual(relative, "");
  assert.equal(relative.includes("\\"), false);
  assert.equal(path.posix.isAbsolute(relative), false);
  assert.equal(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
      relative,
    ),
    false,
    `packed path contains unsupported control characters: ${relative}`,
  );
  const segments = relative.split("/");
  assert.equal(
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ),
    false,
    `unsafe packed path: ${relative}`,
  );
  return path.join(root, ...segments);
}

async function regularFileInventory(root, prefix = "") {
  const output = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    const relative = portablePath(path.join(prefix, entry.name));
    assert.equal(
      entry.isSymbolicLink(),
      false,
      `symbolic link is not allowed in the package tree: ${relative}`,
    );
    if (entry.isDirectory()) {
      output.push(...await regularFileInventory(absolute, relative));
    } else {
      assert.equal(
        entry.isFile(),
        true,
        `non-regular package entry: ${relative}`,
      );
      output.push(relative);
    }
  }
  return output;
}

async function expectedPublishedFiles() {
  const files = ["LICENSE", "README.md", "package.json"];
  for (const directory of PUBLISHED_DIRECTORIES) {
    files.push(
      ...await regularFileInventory(
        path.join(PACKAGE_ROOT, directory),
        directory,
      ),
    );
  }
  files.sort();
  assert.deepEqual(
    files,
    [...EXPECTED_PACKAGE_FILES],
    "publishable source inventory changed; review and update the explicit manifest",
  );
  return [...EXPECTED_PACKAGE_FILES];
}

function validatePackageMetadata(metadata) {
  assert.equal(metadata.name, "low-fidelity-ux-designer");
  assert.match(
    metadata.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  assert.equal(metadata.private, false);
  assert.equal(metadata.license, "Apache-2.0");
  assert.equal(metadata.type, "module");
  assert.deepEqual(metadata.bin, {
    "low-fidelity-ux-designer": "bin/low-fidelity-ux-designer.mjs",
  });
  assert.deepEqual(metadata.files, [
    "bin",
    "lib",
    "skill",
    "README.md",
    "LICENSE",
  ]);
  assert.equal(metadata.engines?.node, ">=18.18.0");
  assert.equal(metadata.publishConfig?.access, "public");
  assert.equal(metadata.publishConfig?.provenance, false);
  assert.equal(Object.hasOwn(metadata.publishConfig ?? {}, "registry"), false);

  for (const field of DEPENDENCY_FIELDS) {
    assert.equal(
      Object.hasOwn(metadata, field),
      false,
      `published package must not declare ${field}`,
    );
  }
  for (const field of IDENTITY_FIELDS) {
    assert.equal(
      Object.hasOwn(metadata, field),
      false,
      `published package must not contain identity metadata: ${field}`,
    );
  }
  for (const script of LIFECYCLE_SCRIPTS) {
    assert.equal(
      Object.hasOwn(metadata.scripts ?? {}, script),
      false,
      `published package must not define lifecycle script: ${script}`,
    );
  }
}

function validatePackEntries(packResult, expectedFiles) {
  assert.ok(Array.isArray(packResult.files));
  assert.equal(packResult.entryCount, packResult.files.length);
  assert.deepEqual(packResult.bundled ?? [], []);
  const paths = packResult.files.map((entry) => entry.path).sort();
  assert.deepEqual(paths, expectedFiles);

  for (const entry of packResult.files) {
    nativePackPath(PACKAGE_ROOT, entry.path);
    const rootName = entry.path.split("/")[0];
    assert.equal(
      ALLOWED_PACK_ROOTS.has(rootName),
      true,
      `unexpected publish root: ${rootName}`,
    );
    assert.equal(entry.size > 0, true, `empty published file: ${entry.path}`);
  }

  const executable = packResult.files.find(
    (entry) => entry.path === "bin/low-fidelity-ux-designer.mjs",
  );
  assert.ok(executable, "published executable is missing");
  assert.equal(
    (executable.mode & 0o111) !== 0,
    true,
    "published executable mode is not executable",
  );
}

function shaDigest(content, algorithm, encoding) {
  return createHash(algorithm).update(content).digest(encoding);
}

function readTarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const terminator = field.indexOf(0);
  return field
    .subarray(0, terminator === -1 ? field.length : terminator)
    .toString("utf8")
    .trim();
}

function readTarOctal(buffer, start, length, label) {
  const value = readTarString(buffer, start, length).replace(/^0+/, "");
  if (value === "") {
    return 0;
  }
  assert.match(value, /^[0-7]+$/, `invalid tar ${label}`);
  return Number.parseInt(value, 8);
}

function validateTarHeaderChecksum(header, relative) {
  const expected = readTarOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  assert.equal(actual, expected, `invalid tar checksum: ${relative}`);
}

function parseTarArchive(compressed) {
  assert.equal(compressed[0], 0x1f, "tarball is not gzip data");
  assert.equal(compressed[1], 0x8b, "tarball is not gzip data");
  const gzipFlags = compressed[3];
  assert.equal(
    gzipFlags,
    0,
    "gzip header must not contain optional environment metadata",
  );

  const archive = gunzipSync(compressed);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert.equal(
        archive.subarray(offset).every((byte) => byte === 0),
        true,
        "tar archive contains data after its end marker",
      );
      break;
    }
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const relative = prefix ? `${prefix}/${name}` : name;
    validateTarHeaderChecksum(header, relative);
    const size = readTarOctal(header, 124, 12, "size");
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    entries.push({
      gid: readTarOctal(header, 116, 8, "gid"),
      gname: readTarString(header, 297, 32),
      link: readTarString(header, 157, 100),
      mode: readTarOctal(header, 100, 8, "mode"),
      path: relative,
      size,
      type,
      uid: readTarOctal(header, 108, 8, "uid"),
      uname: readTarString(header, 265, 32),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
    assert.equal(
      offset <= archive.length,
      true,
      `tar entry exceeds archive bounds: ${relative}`,
    );
  }
  assert.equal(entries.length > 0, true, "tar archive is empty");
  return { archive, entries };
}

function validateTarballArchive(
  compressed,
  packResult,
  temporaryRoot,
) {
  assert.equal(
    shaDigest(compressed, "sha1", "hex"),
    packResult.shasum,
    "tarball SHA-1 differs from npm pack metadata",
  );
  assert.equal(
    `sha512-${shaDigest(compressed, "sha512", "base64")}`,
    packResult.integrity,
    "tarball SRI differs from npm pack metadata",
  );
  const { archive, entries } = parseTarArchive(compressed);
  const expected = new Map(
    packResult.files.map((entry) => [entry.path, entry]),
  );
  const seen = new Set();
  assert.equal(entries.length, expected.size);
  for (const entry of entries) {
    assert.equal(
      entry.path.startsWith("package/"),
      true,
      `tar path is outside package/: ${entry.path}`,
    );
    const relative = entry.path.slice("package/".length);
    nativePackPath(PACKAGE_ROOT, relative);
    assert.equal(seen.has(relative), false, `duplicate tar entry: ${relative}`);
    seen.add(relative);
    const packed = expected.get(relative);
    assert.ok(packed, `unexpected tar entry: ${entry.path}`);
    assert.equal(entry.type, "0", `non-regular tar entry: ${entry.path}`);
    assert.equal(entry.link, "", `linked tar entry: ${entry.path}`);
    assert.equal(entry.uid, 0, `non-neutral tar uid: ${entry.path}`);
    assert.equal(entry.gid, 0, `non-neutral tar gid: ${entry.path}`);
    assert.equal(entry.uname, "", `tar username is present: ${entry.path}`);
    assert.equal(entry.gname, "", `tar group name is present: ${entry.path}`);
    assert.equal(entry.size, packed.size, `tar size mismatch: ${entry.path}`);
    assert.equal(entry.mode, packed.mode, `tar mode mismatch: ${entry.path}`);
  }
  validateTextPrivacy(
    archive.toString("utf8"),
    "decompressed tar archive",
    runtimePrivacyMarkers(temporaryRoot),
  );
}

function runtimePrivacyMarkers(temporaryRoot) {
  const candidates = [
    PACKAGE_ROOT,
    process.cwd(),
    os.homedir(),
    temporaryRoot,
  ];
  const markers = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length < 6) {
      continue;
    }
    markers.add(candidate);
    markers.add(candidate.split(path.sep).join("/"));
    markers.add(candidate.split(path.sep).join("\\"));
    if (path.isAbsolute(candidate)) {
      markers.add(pathToFileURL(candidate).href);
    }
  }
  return [...markers].filter((marker) => marker.length >= 6);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeIdentityMarkers() {
  const common = new Set([
    "administrator",
    "localhost",
    "localdomain",
    "runner",
    "ubuntu",
  ]);
  const userInfo = os.userInfo();
  const candidates = [
    os.hostname(),
    userInfo.username,
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
    process.env.HOSTNAME,
    process.env.COMPUTERNAME,
  ];
  return [...new Set(candidates)]
    .filter((value) => typeof value === "string" && value.length >= 6)
    .filter((value) => !common.has(value.toLowerCase()));
}

function validateTextPrivacy(text, relative, runtimeMarkers) {
  const forbiddenPatterns = [
    {
      label: "local home path",
      expression: /(?:file:\/\/)?\/(?:Users|home)\/[A-Za-z0-9._-]+\//i,
    },
    {
      label: "Windows user path",
      expression: /(?:file:\/\/\/)?[A-Za-z]:[\\/]Users[\\/][^\\/\s]+[\\/]/i,
    },
    {
      label: "embedded URL credentials",
      expression: /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
    },
    {
      label: "source owner URL",
      expression: /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/\s]+/i,
    },
    {
      label: "SSH repository remote",
      expression: /(?:git@(?:github\.com|gitlab\.com|bitbucket\.org):|ssh:\/\/[^\s]+@)/i,
    },
    {
      label: "private key",
      expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    },
    {
      label: "cloud deployment identifier",
      expression: new RegExp("\\bapp" + "gprj_[A-Za-z0-9]+\\b"),
    },
    {
      label: "AWS access key",
      expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    },
    {
      label: "GitHub access token",
      expression: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    },
    {
      label: "npm access token",
      expression: /\bnpm_[A-Za-z0-9]{20,}\b/,
    },
    {
      label: "API secret token",
      expression: /\bsk-[A-Za-z0-9]{20,}\b/,
    },
  ];

  for (const item of forbiddenPatterns) {
    assert.equal(
      item.expression.test(text),
      false,
      `${relative} contains ${item.label}`,
    );
  }

  const email = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  for (const match of text.matchAll(email)) {
    assert.equal(
      RESERVED_EMAIL_DOMAINS.has(match[1].toLowerCase()),
      true,
      `${relative} contains a non-example email address`,
    );
  }

  const uuid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
  for (const match of text.matchAll(uuid)) {
    assert.equal(
      match[0].toLowerCase(),
      "00000000-0000-0000-0000-000000000000",
      `${relative} contains a non-placeholder UUID`,
    );
  }

  const foldedText = text.toLowerCase();
  for (const marker of runtimeMarkers) {
    assert.equal(
      foldedText.includes(marker.toLowerCase()),
      false,
      `${relative} contains a runtime environment path`,
    );
  }
  for (const marker of runtimeIdentityMarkers()) {
    const expression = new RegExp(
      `(?:^|[^A-Za-z0-9._-])${escapeRegularExpression(marker)}(?:$|[^A-Za-z0-9._-])`,
      "i",
    );
    assert.equal(
      expression.test(text),
      false,
      `${relative} contains a runtime identity value`,
    );
  }
}

async function validatePublishedPrivacy(
  installedRoot,
  packFiles,
  temporaryRoot,
) {
  const markers = runtimePrivacyMarkers(temporaryRoot);
  for (const entry of packFiles) {
    const relative = entry.path;
    const installedPath = nativePackPath(installedRoot, relative);
    const sourcePath = nativePackPath(PACKAGE_ROOT, relative);
    const installed = await fs.readFile(installedPath);
    const source = await fs.readFile(sourcePath);
    assert.equal(
      installed.equals(source),
      true,
      `tarball changed source bytes: ${relative}`,
    );
    assert.equal(
      installed.length,
      entry.size,
      `tarball size differs from pack metadata: ${relative}`,
    );

    const text = installed.toString("utf8");
    if (Buffer.from(text, "utf8").equals(installed)) {
      validateTextPrivacy(text, relative, markers);
    }
  }
}

async function assertMissing(target, label) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return;
    }
    throw error;
  }
  assert.fail(`${label} must not exist`);
}

async function assertPresent(target, label) {
  const metadata = await fs.lstat(target);
  assert.equal(
    metadata.isFile() || metadata.isDirectory() || metadata.isSymbolicLink(),
    true,
    `${label} is not accessible`,
  );
  return metadata;
}

async function createFakeRuntime(caseRoot, hostCli) {
  const fakeBin = path.join(caseRoot, "fake-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const environment = isolatedBaseEnvironment();
  const processTemp = path.join(caseRoot, "process-temp");
  await fs.mkdir(processTemp, { recursive: true });
  environment.TEMP = processTemp;
  environment.TMP = processTemp;
  environment.TMPDIR = processTemp;
  const executableExtension = process.platform === "win32" ? ".CMD" : "";
  const hostExecutable = path.join(
    fakeBin,
    `${hostCli}${executableExtension}`,
  );
  const pythonExecutable = path.join(
    fakeBin,
    process.platform === "win32" ? "py.CMD" : "python3",
  );

  if (process.platform === "win32") {
    await fs.writeFile(hostExecutable, "host discovery placeholder\r\n");
    await fs.writeFile(pythonExecutable, "python discovery placeholder\r\n");
    environment.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  } else {
    await fs.writeFile(pythonExecutable, "python discovery placeholder\n", {
      mode: 0o755,
    });
    await fs.writeFile(hostExecutable, "host discovery placeholder\n", {
      mode: 0o755,
    });
  }
  setIsolatedPath(environment, fakeBin);
  return { environment, pythonExecutable };
}

function memoryStream() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

async function runInstalledCli(runCli, arguments_, runtime) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const exitCode = await runCli(arguments_, {
    ...runtime,
    stdout,
    stderr,
  });
  assert.equal(
    exitCode,
    0,
    `installed CLI failed: ${stderr.text.trim()}`,
  );
  const parsed = parseJsonOutput(
    { stdout: stdout.text },
    "installed CLI",
  );
  assert.equal(parsed.ok, true);
  assert.equal(stderr.text, "");
  return parsed;
}

function assertOwnershipPrivacy(marker, selectedRoot, temporaryRoot) {
  const serialized = JSON.stringify(marker);
  for (const forbidden of [
    selectedRoot,
    temporaryRoot,
    os.homedir(),
  ]) {
    if (typeof forbidden === "string" && forbidden.length >= 6) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        "ownership marker contains an absolute runtime path",
      );
    }
  }
  for (const entry of marker.owned_files) {
    assert.equal(path.posix.isAbsolute(entry.path), false);
    assert.equal(entry.path.includes("\\"), false);
    assert.equal(entry.path.split("/").includes(".."), false);
  }
  assert.equal(path.posix.isAbsolute(marker.review_adapter.path), false);
}

async function auditHostScopeMatrix(
  installedRoot,
  temporaryRoot,
) {
  const configUrl = pathToFileURL(
    path.join(installedRoot, "lib", "config.mjs"),
  ).href;
  const cliUrl = pathToFileURL(
    path.join(installedRoot, "lib", "cli.mjs"),
  ).href;
  const {
    HOSTS,
    OWNERSHIP_FILE,
    PACKAGE_VERSION,
  } = await import(`${configUrl}?audit=${Date.now()}`);
  const { runCli } = await import(`${cliUrl}?audit=${Date.now()}`);
  let completed = 0;

  for (const host of HOST_NAMES) {
    for (const scope of SCOPES) {
      const caseRoot = path.join(
        temporaryRoot,
        "integration",
        `${host}-${scope}`,
      );
      const projectRoot = path.join(caseRoot, "project");
      const userHome = path.join(caseRoot, "home");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.mkdir(userHome, { recursive: true });
      const fakeRuntime = await createFakeRuntime(
        caseRoot,
        HOSTS[host].cli,
      );
      const { environment, pythonExecutable } = fakeRuntime;
      environment.HOME = userHome;
      environment.USERPROFILE = userHome;
      environment.XDG_CONFIG_HOME = path.join(userHome, ".config");
      environment.XDG_CACHE_HOME = path.join(userHome, ".cache");

      const scopeArguments = scope === "project"
        ? ["--project-root", projectRoot]
        : ["--scope", "user"];
      const commandArguments = [
        "--host",
        host,
        ...scopeArguments,
        "--json",
      ];
      let pythonCalls = 0;
      const runtime = {
        cwd: projectRoot,
        env: environment,
        home: userHome,
        platform: process.platform,
        spawnSync(executable, arguments_, options) {
          pythonCalls += 1;
          assert.equal(path.resolve(executable), path.resolve(pythonExecutable));
          assert.equal(options.shell, false);
          assert.deepEqual(
            arguments_,
            process.platform === "win32"
              ? ["-3", "--version"]
              : ["--version"],
          );
          return {
            status: 0,
            stdout: "Python 3.11.9\n",
            stderr: "",
          };
        },
      };

      const installed = await runInstalledCli(
        runCli,
        ["install", ...commandArguments],
        runtime,
      );
      assert.equal(installed.host, host);
      assert.equal(installed.scope, scope);
      assert.equal(installed.version, PACKAGE_VERSION);

      const selectedRoot = await fs.realpath(
        scope === "project" ? projectRoot : userHome,
      );
      const core = path.join(
        selectedRoot,
        ...HOSTS[host].core[scope],
      );
      const adapter = path.join(
        selectedRoot,
        ...HOSTS[host].adapter[scope],
      );
      await assertPresent(core, "installed core Skill");
      await assertPresent(adapter, "installed review adapter");

      const marker = JSON.parse(
        await fs.readFile(path.join(core, OWNERSHIP_FILE), "utf8"),
      );
      assert.equal(marker.host, host);
      assert.equal(marker.scope, scope);
      assertOwnershipPrivacy(marker, selectedRoot, temporaryRoot);
      const adapterText = await fs.readFile(adapter, "utf8");
      assert.equal(adapterText.includes("<skill-root>"), false);
      assert.equal(adapterText.includes(selectedRoot), false);
      assert.equal(
        adapterText.includes(
          scope === "project" ? "<project-root>" : "<user-home>",
        ),
        true,
      );

      const doctor = await runInstalledCli(
        runCli,
        ["doctor", ...commandArguments],
        runtime,
      );
      assert.equal(doctor.command, "doctor");
      assert.equal(
        doctor.actions.every((action) => action.status !== "fail"),
        true,
      );
      assert.equal(pythonCalls, 1);

      const uninstalled = await runInstalledCli(
        runCli,
        ["uninstall", ...commandArguments],
        runtime,
      );
      assert.equal(uninstalled.command, "uninstall");
      await assertMissing(core, "uninstalled core Skill");
      await assertMissing(adapter, "uninstalled review adapter");
      completed += 1;
    }
  }
  return completed;
}

async function auditInstalledBin(
  consumerRoot,
  installedRoot,
  temporaryRoot,
  version,
) {
  const installedBin = path.join(
    installedRoot,
    "bin",
    "low-fidelity-ux-designer.mjs",
  );
  const metadata = await fs.stat(installedBin);
  if (process.platform !== "win32") {
    assert.equal(
      (metadata.mode & 0o111) !== 0,
      true,
      "installed package bin is not executable",
    );
  }

  const binHome = path.join(temporaryRoot, "bin-home");
  const binTemp = path.join(temporaryRoot, "bin-temp");
  await fs.mkdir(binHome, { recursive: true });
  await fs.mkdir(binTemp, { recursive: true });
  const environment = isolatedBaseEnvironment();
  environment.HOME = binHome;
  environment.USERPROFILE = binHome;
  environment.TEMP = binTemp;
  environment.TMP = binTemp;
  environment.TMPDIR = binTemp;
  environment.XDG_CACHE_HOME = path.join(binHome, ".cache");
  environment.XDG_CONFIG_HOME = path.join(binHome, ".config");
  setIsolatedPath(environment, path.dirname(process.execPath));

  const direct = runProcess(
    process.execPath,
    [installedBin, "--version"],
    {
      cwd: consumerRoot,
      env: environment,
      label: "installed package bin",
    },
  );
  assert.equal(direct.stdout, `${version}\n`);
  assert.equal(direct.stderr, "");

  const shim = path.join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32"
      ? "low-fidelity-ux-designer.cmd"
      : "low-fidelity-ux-designer",
  );
  await assertPresent(shim, "npm bin shim");
  if (process.platform !== "win32") {
    const shimResult = runProcess(shim, ["--version"], {
      cwd: consumerRoot,
      env: environment,
      label: "npm bin shim",
    });
    assert.equal(shimResult.stdout, `${version}\n`);
    assert.equal(shimResult.stderr, "");
  }
}

async function auditPackage(temporaryRoot) {
  const metadata = JSON.parse(await fs.readFile(PACKAGE_JSON_PATH, "utf8"));
  validatePackageMetadata(metadata);
  const expectedFiles = await expectedPublishedFiles();
  const artifacts = path.join(temporaryRoot, "artifacts");
  const consumer = path.join(temporaryRoot, "consumer");
  await fs.mkdir(artifacts, { recursive: true });
  await fs.mkdir(consumer, { recursive: true });
  const npmEnvironment = await createNpmEnvironment(temporaryRoot);

  const packed = parseJsonOutput(
    runNpm(
      [
        "pack",
        PACKAGE_ROOT,
        "--ignore-scripts",
        "--offline",
        "--json",
        "--pack-destination",
        artifacts,
      ],
      {
        cwd: temporaryRoot,
        env: npmEnvironment,
        label: "npm pack",
      },
    ),
    "npm pack",
  );
  assert.equal(Array.isArray(packed), true);
  assert.equal(packed.length, 1);
  const packResult = packed[0];
  validatePackEntries(packResult, expectedFiles);
  const tarball = path.join(artifacts, packResult.filename);
  assert.equal(path.basename(packResult.filename), packResult.filename);
  const tarballContent = await fs.readFile(tarball);
  const tarballMetadata = await fs.stat(tarball);
  assert.equal(tarballMetadata.isFile(), true);
  assert.equal(tarballMetadata.size, packResult.size);
  validateTarballArchive(tarballContent, packResult, temporaryRoot);

  await fs.writeFile(
    path.join(consumer, "package.json"),
    `${JSON.stringify({
      name: "package-audit-consumer",
      version: "0.0.0",
      private: true,
    }, null, 2)}\n`,
  );
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      tarball,
    ],
    {
      cwd: consumer,
      env: npmEnvironment,
      label: "offline tarball install",
    },
  );

  await assertMissing(
    path.join(consumer, "package-lock.json"),
    "consumer package lock",
  );
  const nodeModulesEntries = (
    await fs.readdir(path.join(consumer, "node_modules"))
  ).sort();
  const allowedNodeModulesEntries = new Set([
    ".bin",
    ".package-lock.json",
    metadata.name,
  ]);
  assert.equal(nodeModulesEntries.includes(".bin"), true);
  assert.equal(nodeModulesEntries.includes(metadata.name), true);
  assert.equal(
    nodeModulesEntries.every((entry) => allowedNodeModulesEntries.has(entry)),
    true,
    "offline install created an unexpected dependency entry",
  );

  const installedRoot = path.join(
    consumer,
    "node_modules",
    metadata.name,
  );
  const installedFiles = (
    await regularFileInventory(installedRoot)
  ).sort();
  const packedFiles = packResult.files
    .map((entry) => entry.path)
    .sort();
  assert.deepEqual(installedFiles, packedFiles);
  const installedMetadata = JSON.parse(
    await fs.readFile(path.join(installedRoot, "package.json"), "utf8"),
  );
  validatePackageMetadata(installedMetadata);
  await validatePublishedPrivacy(
    installedRoot,
    packResult.files,
    temporaryRoot,
  );
  await auditInstalledBin(
    consumer,
    installedRoot,
    temporaryRoot,
    metadata.version,
  );
  const integrationCases = await auditHostScopeMatrix(
    installedRoot,
    temporaryRoot,
  );

  return {
    ok: true,
    package: `${metadata.name}@${metadata.version}`,
    network_mode: "offline",
    tarball: {
      entry_count: packResult.entryCount,
      integrity_verified: true,
      packed_bytes: packResult.size,
      regular_entries_only: true,
      unpacked_bytes: packResult.unpackedSize,
    },
    installed_tree_matches_tarball: true,
    privacy: "pass",
    integration_cases: integrationCases,
  };
}

async function main() {
  const created = await fs.mkdtemp(
    path.join(os.tmpdir(), "lfuxd-package-audit-"),
  );
  let result;
  try {
    const temporaryRoot = await fs.realpath(created);
    result = await auditPackage(temporaryRoot);
  } finally {
    await fs.rm(created, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  result.temporary_artifacts_removed = true;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Package audit failed: ${error.message}\n`);
  process.exitCode = 1;
});
