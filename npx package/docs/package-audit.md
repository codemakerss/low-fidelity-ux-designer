# Package Audit

Run the release artifact audit from the `npx package` directory:

```bash
npm run audit:package
```

The command is an explicit maintainer check, not an npm lifecycle script. It:

1. creates an isolated operating-system temporary directory;
2. replaces npm home, cache, user configuration, global configuration, and
   registry settings with temporary offline values;
3. runs a real `npm pack --ignore-scripts`;
4. checks the exact publish whitelist, executable mode, metadata, absence of
   dependencies and lifecycle scripts, SHA-1/SHA-512 integrity, tar header
   checksums, neutral ownership fields, regular-file entry types, and common
   privacy or credential patterns;
5. installs the tarball offline into a clean consumer project;
6. proves the installed file tree and bytes match the packed source files;
7. invokes the installed bin, invokes the POSIX npm bin shim, and validates the
   generated Windows shim path;
8. runs installed CLI `install`, `doctor`, and `uninstall` for Codex, Claude
   Code, and OpenCode in both project and user scope;
9. uses only temporary homes, project roots, Python discovery fixtures, and
   host discovery fixtures; and
10. removes the tarball, npm cache, installed package, fake homes, and all
    other audit artifacts in a `finally` cleanup.

The audit never publishes, logs in to npm, starts a real host, reads the real
user npm configuration, or intentionally contacts a registry. Offline mode and
a deliberately unavailable loopback registry endpoint provide complementary
network guards.

The published package explicitly disables npm provenance. A public registry
still associates a publication with a registry account outside the tarball and
adds the account email to public package metadata. If the release must not
expose a personal identity, publish only through a separately audited
non-personal account and non-personal email. If any stable account identity is
forbidden, do not publish this package to a public registry. See npm's official
[privacy notice](https://docs.npmjs.com/policies/privacy/) and
[account documentation](https://docs.npmjs.com/creating-a-new-npm-user-account/).

Do not use trusted publishing for this privacy profile: npm currently creates
provenance automatically for supported trusted-publishing workflows, and the
attestation publicly links source, build, and commit information. See npm's
[provenance documentation](https://docs.npmjs.com/generating-provenance-statements/).

Successful output is one JSON object containing the package version, tarball
sizes, entry count, privacy result, six completed integration cases, and
confirmation that temporary artifacts were removed.

The package metadata defines maintainer-only `test` and `audit:package` npm
scripts for use from a source checkout. Their supporting `tests/`, `docs/`, and
root `scripts/` files are intentionally excluded from the consumer tarball, so
do not invoke those maintainer commands from an installed copy.

This local run validates the current operating system, Node.js, and npm
versions. Before publishing, run the same command in clean macOS, Linux, and
Windows jobs with Node.js 18.18 and the current supported Node.js release.
