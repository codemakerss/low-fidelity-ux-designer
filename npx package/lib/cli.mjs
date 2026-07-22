import {
  HOST_NAMES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SCOPES,
} from "./config.mjs";
import { doctorCommand } from "./doctor.mjs";
import { CliError, usageError } from "./errors.mjs";
import { installCommand, uninstallCommand } from "./installer.mjs";

const COMMANDS = new Set(["install", "doctor", "uninstall"]);
const VALUE_OPTIONS = new Map([
  ["--host", "host"],
  ["--scope", "scope"],
  ["--project-root", "projectRoot"],
]);
const BOOLEAN_OPTIONS = new Map([
  ["--no-review-adapter", "noReviewAdapter"],
  ["--dry-run", "dryRun"],
  ["--json", "json"],
  ["--force", "force"],
  ["--help", "help"],
]);

const HELP = `low-fidelity-ux-designer ${PACKAGE_VERSION}

Usage:
  low-fidelity-ux-designer install --host <host> [options]
  low-fidelity-ux-designer doctor --host <host> [options]
  low-fidelity-ux-designer uninstall --host <host> [options]

Hosts:
  codex | claude-code | opencode

Options:
  --scope <project|user>   Installation scope (default: project)
  --project-root <path>    Existing project root (default: current directory)
  --no-review-adapter      Install the core Skill without the review adapter
  --dry-run                Show install/uninstall actions without writing
  --force                  Back up and replace install/uninstall conflicts
  --json                   Emit one machine-readable JSON object
  --help                   Show help
  --version                Show package version
`;

function write(stream, text) {
  stream.write(text);
}

function optionWithEquals(argument) {
  const separator = argument.indexOf("=");
  if (separator < 0) {
    return null;
  }
  return {
    option: argument.slice(0, separator),
    value: argument.slice(separator + 1),
  };
}

export function parseArguments(argv) {
  if (argv.length === 0) {
    return { mode: "help" };
  }
  if (argv[0] === "--help") {
    if (argv.length !== 1) {
      throw usageError("--help cannot be combined with other arguments");
    }
    return { mode: "help" };
  }
  if (argv[0] === "--version") {
    if (argv.length !== 1) {
      throw usageError("--version cannot be combined with other arguments");
    }
    return { mode: "version" };
  }

  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw usageError(`unknown command: ${command}`);
  }

  const options = {
    command,
    host: null,
    scope: "project",
    projectRoot: undefined,
    projectRootProvided: false,
    noReviewAdapter: false,
    dryRun: false,
    json: false,
    force: false,
    help: false,
  };
  const seen = new Set();

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const withEquals = optionWithEquals(argument);
    const optionName = withEquals?.option ?? argument;

    if (VALUE_OPTIONS.has(optionName)) {
      if (seen.has(optionName)) {
        throw usageError(`option may be provided only once: ${optionName}`);
      }
      const value = withEquals ? withEquals.value : argv[++index];
      if (!value || value.startsWith("--")) {
        throw usageError(`option requires a value: ${optionName}`);
      }
      const property = VALUE_OPTIONS.get(optionName);
      options[property] = value;
      if (property === "projectRoot") {
        options.projectRootProvided = true;
      }
      seen.add(optionName);
      continue;
    }

    if (BOOLEAN_OPTIONS.has(optionName)) {
      if (withEquals) {
        throw usageError(`boolean option does not accept a value: ${optionName}`);
      }
      if (seen.has(optionName)) {
        throw usageError(`option may be provided only once: ${optionName}`);
      }
      options[BOOLEAN_OPTIONS.get(optionName)] = true;
      seen.add(optionName);
      continue;
    }

    throw usageError(`unknown option: ${argument}`);
  }

  if (options.help) {
    return { mode: "help", command };
  }
  if (!options.host) {
    throw usageError("--host is required");
  }
  if (!HOST_NAMES.includes(options.host)) {
    throw usageError(
      `--host must be one of: ${HOST_NAMES.join(", ")}`,
    );
  }
  if (!SCOPES.includes(options.scope)) {
    throw usageError(`--scope must be one of: ${SCOPES.join(", ")}`);
  }
  if (options.scope === "user" && options.projectRootProvided) {
    throw usageError("--project-root cannot be used with --scope user");
  }
  if (command !== "install" && options.noReviewAdapter) {
    throw usageError("--no-review-adapter applies only to install");
  }
  if (command === "doctor" && (options.dryRun || options.force)) {
    throw usageError("doctor is read-only and does not accept --dry-run or --force");
  }

  return {
    mode: "command",
    options,
  };
}

function displayPathAction(action) {
  const path = action.path ? ` ${action.path}` : "";
  const destination = action.destination
    ? ` -> ${action.destination}`
    : "";
  return `  [${action.type}]${path}${destination}\n`;
}

function emitHumanResult(result, stdout, stderr) {
  const label = result.ok ? "completed" : "found problems";
  write(stdout, `${result.command} ${label}.\n`);
  for (const action of result.actions ?? []) {
    if (action.type === "check") {
      write(
        stdout,
        `  [${action.status}] ${action.name}: ${action.message}\n`,
      );
    } else {
      write(stdout, displayPathAction(action));
    }
  }
  for (const warning of result.warnings ?? []) {
    write(stderr, `WARNING: ${warning.message}\n`);
  }
}

function failureEnvelope(error, argv, parsed = null) {
  const options = parsed?.options;
  const guessedCommand = COMMANDS.has(argv[0]) ? argv[0] : null;
  return {
    ok: false,
    command: options?.command ?? guessedCommand,
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    host: options?.host ?? null,
    scope: options?.scope ?? null,
    dry_run: Boolean(options?.dryRun),
    actions: [],
    warnings: [],
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
    },
  };
}

export async function runCli(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const wantsJson = argv.includes("--json");
  let parsed = null;

  try {
    parsed = parseArguments(argv);
    if (parsed.mode === "help") {
      write(stdout, HELP);
      return 0;
    }
    if (parsed.mode === "version") {
      write(stdout, `${PACKAGE_VERSION}\n`);
      return 0;
    }

    let result;
    if (parsed.options.command === "install") {
      result = await installCommand(parsed.options, runtime);
    } else if (parsed.options.command === "doctor") {
      result = await doctorCommand(parsed.options, runtime);
    } else {
      result = await uninstallCommand(parsed.options, runtime);
    }

    if (parsed.options.json) {
      write(stdout, `${JSON.stringify(result)}\n`);
    } else {
      emitHumanResult(result, stdout, stderr);
    }
    return result.ok ? 0 : 1;
  } catch (caught) {
    const error =
      caught instanceof CliError
        ? caught
        : new CliError("Operation failed without changing managed content.", {
            exitCode: 1,
            code: "operation_failed",
          });
    if (wantsJson || parsed?.options?.json) {
      write(stdout, `${JSON.stringify(failureEnvelope(error, argv, parsed))}\n`);
    }
    write(stderr, `ERROR: ${error.message}\n`);
    return error.exitCode;
  }
}

export { HELP };
