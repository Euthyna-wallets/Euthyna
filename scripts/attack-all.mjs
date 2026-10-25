#!/usr/bin/env node
// Runs every attack against MandateOS and prints which lock refused each one.
// On-chain attacks run against a real vault in a NEAR sandbox; Guard attacks
// run against the Guard with an in-memory database.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(label, command, args, cwd) {
  return new Promise((resolve) => {
    process.stdout.write(`\n▶ ${label}\n`);
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      const lines = output.split("\n").filter((line) => line.startsWith("BLOCKED |"));
      if (code !== 0) process.stdout.write(output.split("\n").filter((line) => !line.includes("neard::cli")).join("\n"));
      resolve({ label, ok: code === 0, lines });
    });
  });
}

const results = [
  await run("Vault (NEAR sandbox)", "cargo", ["test", "-p", "tests", "--test", "attacks", "--", "--nocapture", "--test-threads=1"], `${root}/contracts`),
  await run("Guard", "pnpm", ["--filter", "@mandateos/api", "exec", "vitest", "run", "src/attacks.test.ts"], root),
];

let count = 0;
for (const result of results) {
  console.log(`\n${result.label}${result.ok ? "" : "  ✗ FAILED"}`);
  for (const line of result.lines) {
    const [, attack, lock, code] = line.split("|").map((part) => part.trim());
    count += 1;
    console.log(`  ✓ ${attack}\n      refused by ${lock} (${code})`);
  }
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${count} attacks refused${failed.length ? `, ${failed.length} suite(s) failed` : ", 0 got through"}.`);
process.exit(failed.length ? 1 : 0);
