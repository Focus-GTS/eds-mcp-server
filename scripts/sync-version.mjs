#!/usr/bin/env node
/**
 * Copies the version from package.json into server.json.
 *
 * The MCP Registry manifest carries its own version in two places
 * (`version` and `packages[0].version`), and the release workflow refuses to
 * publish when either disagrees with the git tag. Rather than remembering
 * three places to edit, this runs automatically from the `version` lifecycle
 * script (see package.json) so `npm version patch` keeps them all in step.
 */

import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const serverPath = "server.json";
const server = JSON.parse(readFileSync(serverPath, "utf8"));

const target = pkg.version;
const before = { top: server.version, pkg: server.packages?.[0]?.version };

server.version = target;
if (Array.isArray(server.packages)) {
  for (const p of server.packages) p.version = target;
}

// Keep mcpName authoritative in package.json; mirror it so the registry's
// ownership check cannot fail on a mismatch nobody noticed.
if (pkg.mcpName && server.name !== pkg.mcpName) {
  console.log(`  name: ${server.name} -> ${pkg.mcpName}`);
  server.name = pkg.mcpName;
}

writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");

if (before.top === target && before.pkg === target) {
  console.log(`server.json already at ${target}`);
} else {
  console.log(
    `server.json ${before.top}/${before.pkg} -> ${target} (top-level/package)`,
  );
}
