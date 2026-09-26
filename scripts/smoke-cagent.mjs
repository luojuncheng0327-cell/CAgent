#!/usr/bin/env node
// Boot the real server with disposable data, verify HTTP/auth contracts, and
// stop it. This never reads the user's Hana data or calls a model provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefix = path.join(os.tmpdir(), "cagent-smoke-");
const smokeHome = fs.mkdtempSync(prefix);
const child = spawn(process.execPath, ["server/main-full.ts"], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, HANA_HOME: smokeHome, HANA_PORT: "0", HANA_CREATE_STARTUP_SESSION: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
const capture = (chunk) => { output = (output + chunk.toString()).slice(-12_000); };
child.stdout.on("data", capture);
child.stderr.on("data", capture);
let spawnError;
child.on("error", (error) => { spawnError = error; });

try {
  const infoPath = path.join(smokeHome, "server-info.json");
  const deadline = Date.now() + 60_000;
  let info;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}\n${output}`);
    try { info = JSON.parse(fs.readFileSync(infoPath, "utf8")); } catch { /* not ready yet */ }
    if (info?.port && info?.token) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(info?.port && info?.token, `Server readiness timed out\n${output}`);
  const origin = `http://127.0.0.1:${info.port}`;
  const headers = { Authorization: `Bearer ${info.token}` };
  const identity = await fetch(`${origin}/api/server/identity`, { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(identity.status, 200);
  const body = await identity.json();
  assert.ok(body.serverProtocol !== undefined);
  const agents = await fetch(`${origin}/api/agents`, { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(agents.status, 200);
  const denied = await fetch(`${origin}/api/agents`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(denied.status, 403);
  console.log(JSON.stringify({ ok: true, boot: "source", identity: identity.status, agents: agents.status, unauthenticated: denied.status, modelRequests: 0 }));
} finally {
  if (child.exitCode === null && !spawnError) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  assert.ok(path.resolve(smokeHome).startsWith(path.resolve(prefix)));
  fs.rmSync(smokeHome, { recursive: true, force: true });
}
