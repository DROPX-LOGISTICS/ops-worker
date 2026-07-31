import puppeteer, { type Browser, type Page, type HTTPRequest } from '@cloudflare/puppeteer';
import type { Env, AmazonAuthContext } from '../types';

const BASE = 'https://www.amazonlogistics.eu';
const CASH_OVERVIEW_PATH = '/station/dashboard/cashoverview';
const PROXY_PATH = '/station/proxyapigateway/data';
const CAPTURE_TIMEOUT_MS = 90_000;

export interface PortalLoginInput {
  email: string;
  password: string;
  stationCode: string;
}

export type PortalLoginResult =
  | { ok: true; auth: AmazonAuthContext }
  | { ok: false; error: string; code: 'LOGIN_FAILED' | 'MFA_REQUIRED' | 'CAPTURE_TIMEOUT' | 'BROWSER_ERROR' };

/**
 * Headless login via Cloudflare Browser Rendering.
 *
 * Flow (matches real browser behaviour):
 * 1. Open cash overview — Amazon redirects to /ap/signin if not logged in.
 * 2. Fill email/password, tick Keep me signed in, submit.
 * 3. Amazon returns to cash overview; intercept proxyapigateway for
 *    x-api-usage-key and pull HttpOnly cookies via CDP.
 */
export async function loginAndCaptureSession(env: Env, input: PortalLoginInput): Promise<PortalLoginResult> {
  if (!env.BROWSER) {
    return {
      ok: false,
      code: 'BROWSER_ERROR',
      error:
        'BROWSER binding unavailable. Locally run `npm run session:login` (Node Puppeteer). ' +
        'For Worker-side login use `npm run dev:remote` (disable VPN/WARP) or deploy the worker.',
    };
  }

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1440, height: 900 });

    const baseUrl = (env.AMAZON_PROXY_BASE_URL || BASE).replace(/\/$/, '');
    const cashUrl = `${baseUrl}${CASH_OVERVIEW_PATH}?stationCode=${encodeURIComponent(input.stationCode)}`;

    // Start on the target page — unauthenticated traffic lands on sign-in
    // with return_to=cashoverview, then comes back after a successful login.
    await page.goto(cashUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

    if (isSignInPage(page)) {
      const signedIn = await fillSignInForm(page, input.email, input.password);
      if (!signedIn.ok) return signedIn;

      // If Amazon didn't bounce us back, go explicitly.
      if (!page.url().includes(CASH_OVERVIEW_PATH)) {
        await page.goto(cashUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
      }
    }

    if (isSignInPage(page)) {
      return {
        ok: false,
        code: 'LOGIN_FAILED',
        error: 'Still on the Amazon sign-in page after submitting credentials.',
      };
    }

    const captured = await captureProxyAuth(page, cashUrl);
    if (!captured.ok) return captured;

    return { ok: true, auth: captured.auth };
  } catch (err) {
    return {
      ok: false,
      code: 'BROWSER_ERROR',
      error: `Browser automation failed: ${(err as Error).message}`,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

function isSignInPage(page: Page): boolean {
  const url = page.url();
  return url.includes('/ap/signin') || url.includes('/ap/challenge') || url.includes('/ap?');
}

async function fillSignInForm(
  page: Page,
  email: string,
  password: string,
): Promise<{ ok: true } | PortalLoginResult> {
  // Amazon sometimes uses a two-step email → password flow.
  const emailSel = '#ap_email, input[name="email"]';
  await page.waitForSelector(emailSel, { timeout: 30_000 });
  await page.click(emailSel, { clickCount: 3 });
  await page.type(emailSel, email, { delay: 20 });

  const continueBtn = await page.$('#continue, #continue input, input#continue');
  if (continueBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
      continueBtn.click(),
    ]);
  }

  const passwordSel = '#ap_password, input[name="password"]';
  await page.waitForSelector(passwordSel, { timeout: 30_000 });
  await page.click(passwordSel, { clickCount: 3 });
  await page.type(passwordSel, password, { delay: 20 });

  const remember = await page.$('#auth-remember-me, input[name="rememberMe"]');
  if (remember) {
    const checked = await page.evaluate((el) => {
      const input = el as unknown as { checked?: boolean };
      return Boolean(input.checked);
    }, remember);
    if (!checked) await remember.click();
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => null),
    page.click('#signInSubmit, input#signInSubmit, button[type="submit"]'),
  ]);

  await sleep(1500);

  if (await page.$('#auth-mfa-otpcode, #auth-mfa-form, input[name="otpCode"]')) {
    return {
      ok: false,
      code: 'MFA_REQUIRED',
      error: 'Amazon requires MFA/OTP. Use an account without MFA for auto-login, or upload a session manually.',
    };
  }

  if (isSignInPage(page)) {
    const alertText = await page
      .$eval('.a-alert-content, #auth-error-message-box', (el) => {
        const node = el as unknown as { textContent?: string | null };
        return node.textContent?.trim() ?? '';
      })
      .catch(() => '');
    return {
      ok: false,
      code: 'LOGIN_FAILED',
      error: alertText
        ? `Amazon rejected the login: ${alertText}`
        : 'Amazon login did not leave the sign-in page. Check email/password.',
    };
  }

  return { ok: true };
}

async function captureProxyAuth(
  page: Page,
  cashUrl: string,
): Promise<{ ok: true; auth: AmazonAuthContext } | PortalLoginResult> {
  let xApiUsageKey: string | null = null;

  const onRequest = (req: HTTPRequest) => {
    if (!req.url().includes(PROXY_PATH)) return;
    const headers = req.headers();
    const key = headers['x-api-usage-key'] || headers['X-Api-Usage-Key'];
    if (key) xApiUsageKey = key;
  };

  page.on('request', onRequest);

  try {
    // Ensure we're on cash overview and traffic is flowing.
    if (!page.url().includes(CASH_OVERVIEW_PATH)) {
      await page.goto(cashUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    } else {
      await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => null);
    }

    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    let reloaded = false;
    while (!xApiUsageKey && Date.now() < deadline) {
      if (isSignInPage(page)) {
        return {
          ok: false,
          code: 'LOGIN_FAILED',
          error: 'Redirected to sign-in while capturing session — credentials may be wrong or session blocked.',
        };
      }
      await sleep(1000);
      if (!xApiUsageKey && !reloaded && Date.now() > deadline - CAPTURE_TIMEOUT_MS + 12_000) {
        reloaded = true;
        await page.reload({ waitUntil: 'networkidle2', timeout: 45_000 }).catch(() => null);
      }
    }

    if (!xApiUsageKey) {
      const fromStorage = await page
        .evaluate(() => {
          try {
            return sessionStorage.getItem('boson.apiUsageKey');
          } catch {
            return null;
          }
        })
        .catch(() => null);
      if (fromStorage && fromStorage.includes(':')) xApiUsageKey = fromStorage;
    }

    if (!xApiUsageKey) {
      return {
        ok: false,
        code: 'CAPTURE_TIMEOUT',
        error: `Timed out waiting for ${PROXY_PATH} (x-api-usage-key). Portal UI may have changed.`,
      };
    }

    const cookie = await collectCookieHeader(page);
    if (!cookie.includes('session-token=') || !cookie.includes('at-acbeu=')) {
      return {
        ok: false,
        code: 'LOGIN_FAILED',
        error: `Captured cookie looks incomplete (missing session-token or at-acbeu). length=${cookie.length}`,
      };
    }

    return { ok: true, auth: { cookie, xApiUsageKey } };
  } finally {
    page.off('request', onRequest);
  }
}

async function collectCookieHeader(page: Page): Promise<string> {
  try {
    const client = await page.createCDPSession();
    const result = (await client.send('Network.getAllCookies')) as {
      cookies: Array<{ name: string; value: string; domain: string }>;
    };
    const relevant = result.cookies.filter((c) =>
      /amazonlogistics\.eu|amazon\.in|amazon\.com/i.test(c.domain),
    );
    const byName = new Map<string, string>();
    for (const c of relevant.sort((a, b) => {
      const score = (d: string) => (d.includes('amazonlogistics.eu') ? 0 : 1);
      return score(a.domain) - score(b.domain);
    })) {
      if (!byName.has(c.name)) byName.set(c.name, c.value);
    }
    return Array.from(byName.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  } catch {
    const cookies = await page.cookies('https://www.amazonlogistics.eu');
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
