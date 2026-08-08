/**
 * Local logistics.amazon.in workforce login (Node Puppeteer).
 * Uploads captured cookies to PUT /api/admin/workforce/session.
 *
 * Usage:
 *   npm run workforce:login
 *   npm run workforce:login -- --headed
 *   npm run workforce:login -- --sync
 *   npm run workforce:login -- --worker=https://cash-recon-worker....workers.dev
 *   npm run workforce:login -- --upload-only   # reuse .workforce-session.cookie
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const DEFAULT_BASE = 'https://logistics.amazon.in';
const DEFAULT_COMPANY_ID = 'b63603e9-36e2-4656-9b87-c421489a64a9';
const COOKIE_BACKUP = resolve(process.cwd(), '.workforce-session.cookie');

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

function hasFlag(name) {
  // Prefer argv. Also honor npm_config_* — on some Windows/npm shells,
  // `npm run x -- --flag` drops argv and only sets npm_config_flag.
  const envKey = `npm_config_${name.replace(/-/g, '_')}`;
  const envVal = process.env[envKey];
  if (envVal === 'true' || envVal === '1' || envVal === '') return true;
  return process.argv.some(
    (a) => a === `--${name}` || a === name || a.startsWith(`--${name}=`),
  );
}

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isSignIn(url) {
  return url.includes('/ap/signin') || url.includes('/ap/challenge') || url.includes('/ap/mfa');
}

function cookieComplete(cookie) {
  return (
    cookie.includes('session-token=') &&
    (cookie.includes('at-acbin=') || cookie.includes('sess-at-acbin=')) &&
    cookie.length > 80
  );
}

async function collectCookies(page, baseUrl) {
  const client = await page.createCDPSession();
  const result = await client.send('Network.getAllCookies');
  const relevant = (result.cookies || []).filter((c) =>
    /amazon\.in|amazon\.com|logistics\.amazon/i.test(c.domain),
  );
  const byName = new Map();
  for (const c of relevant.sort((a, b) => {
    const score = (d) => (d.includes('amazon.in') ? 0 : 1);
    return score(a.domain) - score(b.domain);
  })) {
    if (!byName.has(c.name)) byName.set(c.name, c.value);
  }
  if (byName.size === 0) {
    const fallback = await page.cookies(baseUrl, 'https://www.amazon.in');
    return fallback.map((c) => `${c.name}=${c.value}`).join('; ');
  }
  return [...byName.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

async function dismissCaptcha(page) {
  for (let i = 0; i < 3; i++) {
    const form = await page.$('form[action*="validateCaptcha"]');
    if (!form) break;
    console.log('[workforce:login] Soft captcha gate — clicking Continue shopping…');
    const btn = await page.$('button.a-button-text, form[action*="validateCaptcha"] button');
    if (!btn) throw new Error('Captcha present but Continue button not found.');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
      btn.click(),
    ]);
    await sleep(800);
  }
  if (await page.$('form[action*="validateCaptcha"], #captchacharacters')) {
    throw new Error('Amazon captcha still present — try --headed and solve manually, then re-run.');
  }
}

async function fillSignIn(page, email, password) {
  const emailSel = '#ap_email, #ap_email_login, input[name="email"], input[type="email"]';
  await page.waitForSelector(emailSel, { timeout: 30_000 });
  await page.click(emailSel, { clickCount: 3 });
  await page.type(emailSel, email, { delay: 25 });

  console.log('[workforce:login] Email entered — clicking Continue…');
  const continueBtn = await page.$('#continue, input#continue, button#continue, span#continue input');
  if (continueBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
      continueBtn.click(),
    ]);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null);
  }

  const passwordSel = '#ap_password, input[name="password"], input[type="password"]';
  await page.waitForSelector(passwordSel, { timeout: 30_000 });
  console.log('[workforce:login] Password page — signing in…');
  await page.click(passwordSel, { clickCount: 3 });
  await page.type(passwordSel, password, { delay: 25 });

  const remember = await page.$('#auth-remember-me');
  if (remember) {
    const checked = await page.evaluate((el) => el.checked, remember);
    if (!checked) await remember.click();
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90_000 }).catch(() => null),
    page.click('#signInSubmit, input#signInSubmit'),
  ]);
  await sleep(1500);

  if (await page.$('#auth-mfa-otpcode, input[name="otpCode"]')) {
    throw new Error('Amazon requires MFA/OTP — use an account without MFA or upload cookies manually.');
  }
}

async function assertWorkerReachable(workerUrl) {
  const healthUrl = `${workerUrl}/api/health`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      throw new Error(`Health check returned HTTP ${res.status}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach worker at ${workerUrl} (${detail}).\n` +
        `  • Start local worker:  npm run dev   (another terminal)\n` +
        `  • Or set WORKER_URL in .dev.vars to your deployed workers.dev URL\n` +
        `  • Or pass:  npm run workforce:login -- --worker=https://….workers.dev\n` +
        `Cookie backup was saved to ${COOKIE_BACKUP} — retry with: npm run workforce:login -- --upload-only`,
    );
  }
}

async function uploadSession(workerUrl, adminKey, cookie, doSync) {
  console.log(`[workforce:login] Uploading to ${workerUrl}/api/admin/workforce/session …`);
  await assertWorkerReachable(workerUrl);

  let putRes;
  try {
    putRes = await fetch(`${workerUrl}/api/admin/workforce/session`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: JSON.stringify({ cookie, uploadedBy: 'local-workforce-login' }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Upload fetch failed to ${workerUrl}: ${detail}\n` +
        `Cookie saved at ${COOKIE_BACKUP}. Fix WORKER_URL / start worker, then: npm run workforce:login -- --upload-only`,
    );
  }

  const putBody = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    throw new Error(
      `Upload failed ${putRes.status}: ${JSON.stringify(putBody)}\n` +
        `(If 404, deploy the worker so /api/admin/workforce/* routes exist.)`,
    );
  }
  console.log('[workforce:login] Session stored:', putBody.id || putBody.status);

  if (doSync) {
    console.log('[workforce:login] Syncing roster…');
    const syncRes = await fetch(`${workerUrl}/api/admin/workforce/roster/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': adminKey,
      },
      body: '{}',
      signal: AbortSignal.timeout(120_000),
    });
    const syncBody = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok) {
      throw new Error(`Roster sync failed ${syncRes.status}: ${JSON.stringify(syncBody)}`);
    }
    console.log('[workforce:login] Roster synced:', syncBody.count, 'associates');
  }

  return putBody;
}

export async function runLocalWorkforceLogin(overrides = {}) {
  const env = { ...loadDevVars(), ...process.env, ...overrides };
  const email = env.WORKFORCE_PORTAL_EMAIL || env.logistics_id;
  const password = env.WORKFORCE_PORTAL_PASSWORD || env.logistics_password;
  const adminKey = env.ADMIN_API_KEY;
  const workerUrl = (argValue('worker') || env.WORKER_URL || 'http://127.0.0.1:8787').replace(
    /\/$/,
    '',
  );
  const baseUrl = (env.WORKFORCE_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const companyId = env.WORKFORCE_COMPANY_ID || DEFAULT_COMPANY_ID;
  const headed = Boolean(env.HEADED) || hasFlag('headed');
  const doSync = hasFlag('sync');
  const uploadOnly = hasFlag('upload-only');

  if (!adminKey) throw new Error('Set ADMIN_API_KEY in .dev.vars');

  if (uploadOnly) {
    if (!existsSync(COOKIE_BACKUP)) {
      throw new Error(`No ${COOKIE_BACKUP} — run a full login first (without --upload-only).`);
    }
    const cookie = readFileSync(COOKIE_BACKUP, 'utf8').trim();
    if (!cookieComplete(cookie)) {
      throw new Error(`Backup cookie incomplete in ${COOKIE_BACKUP}`);
    }
    console.log(`[workforce:login] Re-uploading saved cookie (len=${cookie.length})…`);
    return uploadSession(workerUrl, adminKey, cookie, doSync);
  }

  if (!email || !password) {
    throw new Error('Set WORKFORCE_PORTAL_EMAIL and WORKFORCE_PORTAL_PASSWORD in .dev.vars');
  }

  const entryUrl = `${baseUrl}/performance?`;
  const workforceUrl =
    `${baseUrl}/workforce?pageId=da_console_associates&station=ALL` +
    `&companyId=${encodeURIComponent(companyId)}&tabId=da-console-associates-tab`;

  console.log(`[workforce:login] Launching Chrome (${headed ? 'headed' : 'headless'})…`);
  console.log(`[workforce:login] Entry: ${entryUrl}`);
  console.log(`[workforce:login] Worker upload target: ${workerUrl}`);

  const browser = await puppeteer.launch({
    headless: headed ? false : true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(entryUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
    await dismissCaptcha(page);

    if (isSignIn(page.url())) {
      console.log('[workforce:login] Sign-in page — filling credentials…');
      await fillSignIn(page, email, password);
      await dismissCaptcha(page);
    }

    if (isSignIn(page.url())) {
      const alertText = await page
        .$eval('.a-alert-content, #auth-error-message-box', (el) => el.textContent?.trim() ?? '')
        .catch(() => '');
      throw new Error(alertText || 'Still on sign-in after submit — check email/password.');
    }

    console.log('[workforce:login] Logged in — URL:', page.url());
    await page.goto(workforceUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
    await dismissCaptcha(page);
    if (isSignIn(page.url())) {
      throw new Error('Redirected to sign-in on workforce page — account may lack DSP access.');
    }

    let cookie = await collectCookies(page, baseUrl);
    const deadline = Date.now() + 45_000;
    while (!cookieComplete(cookie) && Date.now() < deadline) {
      await sleep(1500);
      cookie = await collectCookies(page, baseUrl);
    }
    if (!cookieComplete(cookie)) {
      throw new Error(`Incomplete cookie jar (len=${cookie.length}). Need session-token + at-acbin.`);
    }

    writeFileSync(COOKIE_BACKUP, cookie, 'utf8');
    console.log(`[workforce:login] Cookie captured (len=${cookie.length}) — saved ${COOKIE_BACKUP}`);

    return uploadSession(workerUrl, adminKey, cookie, doSync);
  } finally {
    await browser.close().catch(() => null);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('local-workforce-login.mjs')) {
  runLocalWorkforceLogin()
    .then(() => {
      console.log('[workforce:login] Done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[workforce:login] FAILED:', err.message || err);
      process.exit(1);
    });
}
