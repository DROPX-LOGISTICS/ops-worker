/**
 * npm run dev — starts local wrangler, then ensures Amazon session is valid.
 * If session is missing/invalid, runs Node Puppeteer login automatically
 * (no separate `session:login` step required).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runLocalSessionLogin } from './local-session-login.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDevVars() {
  const path = resolve(process.cwd(), '.dev.vars');
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const WORKER = 'http://127.0.0.1:8787';
const envVars = loadDevVars();

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WORKER}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Worker did not become ready on http://127.0.0.1:8787');
}

async function ensureSession() {
  const adminKey = envVars.ADMIN_API_KEY;
  if (!adminKey) {
    console.warn('[dev] ADMIN_API_KEY missing — skip session ensure');
    return;
  }

  console.log('[dev] Checking Amazon session…');
  const statusRes = await fetch(`${WORKER}/api/admin/session/status`, {
    headers: { 'x-admin-key': adminKey },
  });
  const status = await statusRes.json().catch(() => ({}));

  if (status.status === 'active') {
    // Probe via ensure endpoint semantics: POST refresh is heavy; use a soft
    // validate-path by calling ensure through a dedicated admin route.
    const ensureRes = await fetch(`${WORKER}/api/admin/session/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ triggeredBy: 'npm-run-dev' }),
    });
    const ensureBody = await ensureRes.json().catch(() => ({}));

    if (ensureRes.ok && ensureBody.status === 'ok') {
      console.log(`[dev] Session OK (source=${ensureBody.source})`);
      return;
    }

    if (ensureBody.code === 'NEEDS_LOCAL_LOGIN' || ensureBody.needsLocalLogin) {
      console.log('[dev] Session invalid — running local Puppeteer login…');
      await runLocalSessionLogin();
      return;
    }

    if (!ensureRes.ok) {
      console.warn('[dev] ensure failed:', ensureBody);
      if (ensureBody.needsLocalLogin || ensureBody.code === 'NEEDS_LOCAL_LOGIN' || ensureBody.code === 'BROWSER_ERROR') {
        console.log('[dev] Falling back to local Puppeteer login…');
        await runLocalSessionLogin();
      }
      return;
    }
  } else {
    console.log(`[dev] No active session (status=${status.status}) — running local Puppeteer login…`);
    await runLocalSessionLogin();
  }
}

function startWrangler() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'dev', '-c', 'wrangler.dev.toml'], {
      cwd: process.cwd(),
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: process.env,
    });

    let ready = false;
    const onReady = () => {
      if (ready) return;
      ready = true;
      resolve(child);
    };

    const attach = (stream) => {
      if (!stream) return;
      const rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        process.stdout.write(`${line}\n`);
        if (line.includes('Ready on') || line.includes('Starting local server')) {
          // Give the server a beat after the ready log.
          setTimeout(onReady, 800);
        }
      });
    };

    attach(child.stdout);
    attach(child.stderr);

    child.on('error', reject);
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`wrangler exited before ready (code=${code})`));
    });
  });
}

async function main() {
  console.log('[dev] Starting wrangler (local, no Browser Rendering)…');
  const child = await startWrangler();
  await waitForHealth();

  try {
    await ensureSession();
  } catch (err) {
    console.error('[dev] Session ensure FAILED:', err.message || err);
    console.error('[dev] Owner should fix AMAZON_PORTAL_* credentials. Worker stays up for manual upload.');
  }

  console.log('[dev] Ready — frontend can POST /api/validate with its own stationCode.');

  const shutdown = () => {
    child.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error('[dev] FAILED:', err.message || err);
  process.exit(1);
});
