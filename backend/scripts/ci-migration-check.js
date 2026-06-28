#!/usr/bin/env node
/**
 * CI-safe migration compile check.
 *
 * Verifies that every TypeScript migration has a compiled JS counterpart
 * and that all migrations can be imported without throwing.
 *
 * Usage (after `npm run build` in backend/):
 *   node backend/scripts/ci-migration-check.js
 */

const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src", "migrations");
const distDir = path.join(__dirname, "..", "dist", "src", "migrations");

let ok = true;

const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));

for (const src of srcFiles) {
  const expected = src.replace(/\.ts$/, ".js");
  if (!distFiles.includes(expected)) {
    console.error(`[migration-check] missing compiled JS for ${src}`);
    ok = false;
  }
}

for (const dist of distFiles) {
  try {
    require(path.join(distDir, dist));
  } catch (err) {
    console.error(
      `[migration-check] failed to import ${dist}: ${err.message}`
    );
    ok = false;
  }
}

if (ok) {
  console.log(
    `[migration-check] ${srcFiles.length} migration(s) compiled and importable`
  );
  process.exit(0);
} else {
  process.exit(1);
}
