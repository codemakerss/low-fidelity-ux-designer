import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

import {
  PACKAGE_META,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  STATE_DIRECTORY,
} from "./config.mjs";
import {
  inspectInstallation,
  validateInstalledSkill,
  validatePayload,
} from "./managed-state.mjs";
import {
  inspectTransactionState,
  lstatOrNull,
} from "./fs-utils.mjs";
import { resolveTargets } from "./targets.mjs";

function versionTuple(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const left = versionTuple(actual);
  const right = versionTuple(minimum);
  if (!left || !right) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return true;
    }
    if (left[index] < right[index]) {
      return false;
    }
  }
  return true;
}

function minimumNodeVersion() {
  const configured = PACKAGE_META.engines?.node ?? ">=18.18.0";
  const match = configured.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? "18.18.0";
}

async function executableExists(candidate, platform) {
  try {
    await fs.access(
      candidate,
      platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    const metadata = await fs.stat(candidate);
    return metadata.isFile();
  } catch {
    return false;
  }
}

export async function findExecutable(command, env = process.env, platform = process.platform) {
  if (command.includes("/") || command.includes("\\")) {
    return (await executableExists(command, platform)) ? command : null;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  const commandHasExtension = path.extname(command).length > 0;

  for (const directory of directories) {
    const candidates =
      platform === "win32" && !commandHasExtension
        ? extensions.map((extension) => path.join(directory, `${command}${extension}`))
        : [path.join(directory, command)];
    for (const candidate of candidates) {
      if (await executableExists(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

function pythonCandidates(platform) {
  if (platform === "win32") {
    return [
      { command: "py", arguments: ["-3", "--version"] },
      { command: "python", arguments: ["--version"] },
      { command: "python3", arguments: ["--version"] },
    ];
  }
  return [
    { command: "python3", arguments: ["--version"] },
    { command: "python", arguments: ["--version"] },
  ];
}

async function detectPython(runtime) {
  const platform = runtime.platform ?? process.platform;
  const env = runtime.env ?? process.env;
  const spawn = runtime.spawnSync ?? nodeSpawnSync;
  for (const candidate of pythonCandidates(platform)) {
    const executable = await findExecutable(candidate.command, env, platform);
    if (!executable) {
      continue;
    }
    const result = spawn(executable, candidate.arguments, {
      encoding: "utf8",
      env,
      shell: false,
      timeout: 5000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = output.match(/Python\s+(\d+\.\d+\.\d+)/i);
    if (result.status === 0 && match) {
      return {
        found: true,
        ready: versionAtLeast(match[1], "3.10.0"),
        version: match[1],
      };
    }
  }
  return {
    found: false,
    ready: false,
    version: null,
  };
}

function check(name, status, message) {
  return {
    type: "check",
    name,
    status,
    message,
  };
}

export async function doctorCommand(options, runtime = {}) {
  const checks = [];
  const warnings = [];
  const minimumNode = minimumNodeVersion();
  const nodeReady = versionAtLeast(process.versions.node, minimumNode);
  checks.push(
    check(
      "node",
      nodeReady ? "pass" : "fail",
      nodeReady
        ? `Node.js ${process.versions.node} satisfies >=${minimumNode}.`
        : `Node.js >=${minimumNode} is required.`,
    ),
  );

  const python = await detectPython(runtime);
  checks.push(
    check(
      "python",
      python.ready ? "pass" : "fail",
      python.ready
        ? `Python ${python.version} satisfies >=3.10.0.`
        : python.found
          ? `Python ${python.version} is below 3.10.0.`
          : "Python 3.10 or newer was not found.",
    ),
  );

  try {
    await validatePayload();
    checks.push(check("package_payload", "pass", "Packaged Skill payload is valid."));
  } catch (error) {
    checks.push(check("package_payload", "fail", error.message));
  }

  let targets = null;
  try {
    targets = await resolveTargets(options, runtime, {
      checkDuplicates: false,
    });
    checks.push(check("discovery_paths", "pass", "Discovery paths are contained and safe."));
  } catch (error) {
    checks.push(check("discovery_paths", "fail", error.message));
  }

  if (targets) {
    try {
      const transactionState = await inspectTransactionState(
        targets.root,
        STATE_DIRECTORY,
      );
      checks.push(
        check(
          "transaction_state",
          transactionState.incomplete ? "fail" : "pass",
          transactionState.incomplete
            ? `An incomplete transaction requires manual recovery at ${transactionState.path}.`
            : "No incomplete transaction state was found.",
        ),
      );
    } catch (error) {
      checks.push(check("transaction_state", "fail", error.message));
    }

    if (targets.duplicates.length > 0) {
      checks.push(
        check(
          "duplicate_discovery",
          "fail",
          "The same Skill name exists in another supported discovery location.",
        ),
      );
    } else {
      checks.push(
        check(
          "duplicate_discovery",
          "pass",
          "No duplicate supported discovery location was found.",
        ),
      );
    }

    const installation = await inspectInstallation(targets);
    if (!installation.exists) {
      checks.push(
        check("installation", "fail", "No managed installation was found."),
      );
    } else if (!installation.owned) {
      checks.push(
        check(
          "installation",
          "fail",
          `Installation ownership is invalid: ${installation.issues.join("; ")}`,
        ),
      );
    } else if (!installation.unchanged) {
      checks.push(
        check(
          "installation",
          "fail",
          `Managed installation changed: ${installation.issues.join("; ")}`,
        ),
      );
    } else {
      checks.push(
        check(
          "installation",
          "pass",
          `Managed installation ${installation.marker.package_version} is intact.`,
        ),
      );
      try {
        await validateInstalledSkill(targets.core);
        checks.push(
          check(
            "skill_frontmatter",
            "pass",
            "Installed SKILL.md frontmatter is valid.",
          ),
        );
      } catch (error) {
        checks.push(check("skill_frontmatter", "fail", error.message));
      }
      if (installation.marker.review_adapter) {
        const adapterText = await fs.readFile(targets.adapter, "utf8");
        checks.push(
          check(
            "review_adapter",
            adapterText.includes("<skill-root>") ? "fail" : "pass",
            adapterText.includes("<skill-root>")
              ? "Review adapter contains an unresolved Skill path."
              : "Review adapter is rendered and intact.",
          ),
        );
      } else {
        const unmanagedAdapter = await lstatOrNull(targets.adapter);
        if (unmanagedAdapter) {
          warnings.push({
            code: "unmanaged_adapter_preserved",
            message: "An existing review adapter is not owned by this installation.",
          });
          checks.push(
            check(
              "review_adapter",
              "warn",
              "An unowned review adapter exists and will be preserved.",
            ),
          );
        } else {
          checks.push(
            check(
              "review_adapter",
              "pass",
              "Review adapter was intentionally not installed.",
            ),
          );
        }
      }
    }

    const hostExecutable = await findExecutable(
      targets.hostCli,
      runtime.env ?? process.env,
      runtime.platform ?? process.platform,
    );
    if (hostExecutable) {
      checks.push(
        check(
          "host_cli",
          "pass",
          `${targets.host} executable is discoverable without starting a session.`,
        ),
      );
    } else {
      warnings.push({
        code: "host_cli_missing",
        message: `${targets.host} executable was not found; file-based handoff remains available.`,
      });
      checks.push(
        check(
          "host_cli",
          "warn",
          `${targets.host} executable was not found.`,
        ),
      );
    }
  }

  const ready = checks.every((entry) => entry.status !== "fail");
  return {
    ok: ready,
    command: "doctor",
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    host: options.host,
    scope: options.scope ?? "project",
    dry_run: false,
    actions: checks,
    warnings,
  };
}
