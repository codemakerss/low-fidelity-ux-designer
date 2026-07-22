import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const PACKAGE_META = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
);

export const PACKAGE_NAME = PACKAGE_META.name;
export const PACKAGE_VERSION = PACKAGE_META.version;
export const SKILL_NAME = "low-fidelity-ux-designer";
export const PAYLOAD_ROOT = path.join(PACKAGE_ROOT, "skill", SKILL_NAME);
export const OWNERSHIP_FILE = ".low-fidelity-ux-designer-install.json";
export const STATE_DIRECTORY = ".low-fidelity-ux-designer";

export const HOSTS = Object.freeze({
  codex: {
    cli: "codex",
    core: {
      project: [".agents", "skills", SKILL_NAME],
      user: [".agents", "skills", SKILL_NAME],
    },
    adapter: {
      project: [".agents", "skills", "review-board", "SKILL.md"],
      user: [".agents", "skills", "review-board", "SKILL.md"],
    },
    adapterTemplate: ["assets", "host-adapters", "codex", "SKILL.md"],
  },
  "claude-code": {
    cli: "claude",
    core: {
      project: [".claude", "skills", SKILL_NAME],
      user: [".claude", "skills", SKILL_NAME],
    },
    adapter: {
      project: [".claude", "skills", "review-board", "SKILL.md"],
      user: [".claude", "skills", "review-board", "SKILL.md"],
    },
    adapterTemplate: ["assets", "host-adapters", "claude-code", "SKILL.md"],
  },
  opencode: {
    cli: "opencode",
    core: {
      project: [".opencode", "skills", SKILL_NAME],
      user: [".config", "opencode", "skills", SKILL_NAME],
    },
    adapter: {
      project: [".opencode", "commands", "review-board.md"],
      user: [".config", "opencode", "commands", "review-board.md"],
    },
    adapterTemplate: [
      "assets",
      "host-adapters",
      "opencode",
      "review-board.md",
    ],
  },
});

export const HOST_NAMES = Object.freeze(Object.keys(HOSTS));
export const SCOPES = Object.freeze(["project", "user"]);
