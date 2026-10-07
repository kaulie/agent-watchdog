import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "run-service.sh");
const start = path.join(root, "scripts", "start.sh");

test("run-service.sh is a foreground exec wrapper, not a daemonizer", () => {
  const text = fs.readFileSync(script, "utf8");
  const body = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.match(body, /^exec node dist\/index\.js$/m);
  assert.doesNotMatch(body, /\bnohup\b/);
  assert.doesNotMatch(body, /start\.sh|restart\.sh/);
});

test("start.sh still daemonizes for the deployment platform", () => {
  const text = fs.readFileSync(start, "utf8");
  assert.match(text, /\bnohup\b/);
  assert.doesNotMatch(text, /^exec node /m);
});
