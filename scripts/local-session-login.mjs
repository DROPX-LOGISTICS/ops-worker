/**
 * Local Amazon session login (Node Puppeteer).
 * Opens cash overview on the SCRAPE station (default TIRC) — not the station
 * the frontend will validate. Cookie + x-api-usage-key are shared across stations.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const BASE = 'https://www.amazonlogistics.eu';
const CASH_PATH = '/station/dashboard/cashoverview';
const PROXY_PATH = '/station/proxyapigateway/data';

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

function argFlag(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function runLocalSessionLogin(overrides = {}) {
  const env = { ...loadDevVars(), ...process.env, ...overrides };
  const email = env.AMAZON_PORTAL_EMAIL;
  const password = env.AMAZON_PORTAL_PASSWORD;
  const adminKey = env.ADMIN_API_KEY;
  const workerUrl = (env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
  // Scrape station only — never use "HO" as a business station.
  const scrapeStation = (env.AMAZON_LOGIN_STATION_CODE || 'TIRC').toUpperCase();
  const headed = Boolean(env.HEADED) || hasFlag('headed');

  if (!email || !password) {
    throw new Error('Set AMAZON_PORTAL_EMAIL and AMAZON_PORTAL_PASSWORD in .dev.vars (uncomment password).');
  }
  if (!adminKey) {
    throw new Error('Set ADMIN_API_KEY in .dev.vars');
  }

  const cashUrl = `${BASE}${CASH_PATH}?stationCode=${encodeURIComponent(scrapeStation)}`;
  console.log(`[session:login] Launching Chrome (${headed ? 'headed' : 'headless'})…`);
  console.log(`[session:login] Scrape station (login capture only): ${scrapeStation}`);
  console.log(`[session:login] Target: ${cashUrl}`);

  const browser = await puppeteer.launch({
    headless: headed ? false : true,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  let xApiUsageKey = null;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    page.on('request', (req) => {
      if (!req.url().includes(PROXY_PATH)) return;
      const key = req.headers()['x-api-usage-key'];
      if (key) {
        xApiUsageKey = key;
        console.log('[session:login] Intercepted x-api-usage-key');
      }
    });

    await page.goto(cashUrl, { waitUntil: 'networkidle2', timeout: 90_000 });

    if (page.url().includes('/ap/signin') || page.url().includes('/ap/challenge')) {
      console.log('[session:login] Sign-in page — filling credentials…');
      await page.waitForSelector('#ap_email, input[name="email"]', { timeout: 30_000 });
      await page.click('#ap_email, input[name="email"]', { clickCount: 3 });
      await page.type('#ap_email, input[name="email"]', email, { delay: 25 });

      const continueBtn = await page.$('#continue, input#continue');
      if (continueBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
          continueBtn.click(),
        ]);
      }

      await page.waitForSelector('#ap_password, input[name="password"]', { timeout: 30_000 });
      await page.click('#ap_password, input[name="password"]', { clickCount: 3 });
      await page.type('#ap_password, input[name="password"]', password, { delay: 25 });

      const remember = await page.$('#auth-remember-me');
      if (remember) {
        const checked = await page.evaluate((el) => el.checked, remember);
        if (!checked) await remember.click();
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90_000 }).catch(() => null),
        page.click('#signInSubmit'),
      ]);
      await new Promise((r) => setTimeout(r, 2500));
    }

    if (page.url().includes('/ap/signin') || page.url().includes('/ap/challenge')) {
      const alertText = await page.$eval('.a-alert-content', (el) => el.textContent?.trim() ?? '').catch(() => '');
      if (await page.$('#auth-mfa-otpcode, input[name="otpCode"]')) {
        throw new Error('Amazon requires MFA/OTP — auto-login cannot continue for this account.');
      }
      throw new Error(alertText || 'Still on sign-in page after submit (check password / passkey).');
    }

    console.log('[session:login] Logged in — URL:', page.url());

    // Land on cash overview for the scrape station and wait for API traffic.
    if (!page.url().includes(CASH_PATH)) {
      await page.goto(cashUrl, { waitUntil: 'networkidle2', timeout: 90_000 });
    }

    // Click around / reload to force proxyapigateway calls.
    for (let i = 0; i < 3 && !xApiUsageKey; i++) {
      await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 3000));
      if (!xApiUsageKey) {
        const fromStorage = await page.evaluate(() => {
          try {
            return sessionStorage.getItem('boson.apiUsageKey');
          } catch {
            return null;
          }
        });
        if (fromStorage && fromStorage.includes(':')) {
          xApiUsageKey = fromStorage;
          console.log('[session:login] Got key from sessionStorage');
        }
      }
    }

    const deadline = Date.now() + 60_000;
    while (!xApiUsageKey && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!xApiUsageKey) {
      throw new Error(
        'Timed out waiting for x-api-usage-key. Try: npm run session:login -- --headed  (and complete any captcha/MFA manually).',
      );
    }

    const cdp = await page.createCDPSession();
    const { cookies } = await cdp.send('Network.getAllCookies');
    const relevant = cookies.filter((c) => /amazonlogistics\.eu|amazon\.in|amazon\.com/i.test(c.domain));
    const byName = new Map();
    for (const c of relevant.sort((a, b) => {
      const score = (d) => (d.includes('amazonlogistics.eu') ? 0 : 1);
      return score(a.domain) - score(b.domain);
    })) {
      if (!byName.has(c.name)) byName.set(c.name, c.value);
    }
    const cookie = [...byName.entries()].map(([n, v]) => `${n}=${v}`).join('; ');

    if (!cookie.includes('session-token=') || !cookie.includes('at-acbeu=')) {
      throw new Error(`Cookie incomplete (len=${cookie.length}). Missing session-token or at-acbeu.`);
    }

    console.log('[session:login] Uploading session to worker…');
    const res = await fetch(`${workerUrl}/api/admin/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ cookie, xApiUsageKey, uploadedBy: email }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Worker rejected upload: ${res.status} ${JSON.stringify(body)}`);
    }
    console.log('[session:login] OK:', body);
    return body;
  } finally {
    await browser.close().catch(() => null);
  }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('local-session-login.mjs');
if (isMain) {
  const station = argFlag('station');
  runLocalSessionLogin(station ? { AMAZON_LOGIN_STATION_CODE: station } : {})
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[session:login] FAILED:', err.message || err);
      process.exit(1);
    });
}
