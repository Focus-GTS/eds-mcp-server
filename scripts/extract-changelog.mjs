#!/usr/bin/env node
/**
 * Extracts one version's section out of CHANGELOG.md.
 *
 * Used by the release workflow to turn the hand-written changelog entry into
 * GitHub Release notes, so release notes and changelog can never disagree.
 *
 * Usage:
 *   node scripts/extract-changelog.mjs 0.3.2
 *   node scripts/extract-changelog.mjs v0.3.2     # leading v is tolerated
 *
 * Writes the section body to stdout. Exits non-zero if the version has no
 * section, which deliberately fails the release rather than publishing with
 * empty notes.
 */

import { readFileSync } from "node:fs";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: extract-changelog.mjs <version>");
  process.exit(1);
}

const version = raw.replace(/^v/, "");

let changelog;
try {
  changelog = readFileSync("CHANGELOG.md", "utf8");
} catch (err) {
  console.error(`Could not read CHANGELOG.md: ${err.message}`);
  process.exit(1);
}

const lines = changelog.split("\n");

// Section headings look like:  ## [0.3.2] - 2026-08-10
const headingFor = (v) =>
  new RegExp(`^##\\s*\\[${v.replace(/\./g, "\\.")}\\]`);

const start = lines.findIndex((l) => headingFor(version).test(l));
if (start === -1) {
  console.error(
    `No CHANGELOG section found for version ${version}.\n` +
      `Expected a heading like:  ## [${version}] - YYYY-MM-DD\n` +
      `Add the entry before tagging — release notes are generated from it.`,
  );
  process.exit(2);
}

// Run to the next version heading (any "## ["), not just any "##", so that
// "### Security" subsections stay inside the section.
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s*\[/.test(lines[i])) {
    end = i;
    break;
  }
}

const body = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();

if (!body) {
  console.error(
    `The CHANGELOG section for ${version} is empty. Refusing to generate ` +
      `empty release notes.`,
  );
  process.exit(3);
}

process.stdout.write(body + "\n");
