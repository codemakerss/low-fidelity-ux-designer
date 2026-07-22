export class CliError extends Error {
  constructor(message, { exitCode = 1, code = "operation_failed", details = {} } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

export function usageError(message) {
  return new CliError(message, {
    exitCode: 2,
    code: "invalid_usage",
  });
}

export function conflictError(message, details = {}) {
  return new CliError(message, {
    exitCode: 3,
    code: "conflict",
    details,
  });
}

export function safetyError(message, details = {}) {
  return new CliError(message, {
    exitCode: 3,
    code: "safety_refusal",
    details,
  });
}
