import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
import type { Env, WorkforceAuthContext } from '../types';
import { workforceBaseUrl, workforceCompanyId } from '../config';

const DEFAULT_ENTRY_PATH = '/performance';
const CAPTURE_TIMEOUT_MS = 60_000;

export interface WorkforceLoginInput {
  email: string;
  password: string;
}

export type WorkforceLoginResult =
  | { ok: true; auth: WorkforceAuthContext }
  | {
      ok: false;
      error: string;
      code:
        | 'LOGIN_FAILED'
        | 'MFA_REQUIRED'
        | 'CAPTCHA_REQUIRED'
        | 'CAPTURE_TIMEOUT'
        | 'BROWSER_ERROR'
        | 'NO_CREDENTIALS';
    };

/**
 * Headless login to logistics.amazon.in via Cloudflare Browser Rendering.
 *
 * Flow (Amazon.in DSP / logistics):
 * 1. Open /performance (or workforce) — unauthenticated traffic hits /ap/signin
 *    (sometimes via a soft captcha "Continue shopping" gate).
 * 2. Enter email → Continue → password → Sign in (Keep me signed in).
 * 3. Land on logistics.amazon.in; collect HttpOnly cookies via CDP.
 */
export async function loginAndCaptureWorkforceSession(
  env: Env,
  input: WorkforceLoginInput,
): Promise<WorkforceLoginResult> {
  if (!env.BROWSER) {
    return {
      ok: false,
      code: 'BROWSER_ERROR',
      error:
        'BROWSER binding unavailable. Locally run `npm run workforce:login` (Node Puppeteer). ' +
        'On Cloudflare use deploy or `npm run dev:remote`.',
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

    const baseUrl = workforceBaseUrl(env);
    const entryUrl = `${baseUrl}${DEFAULT_ENTRY_PATH}?`;
    const companyId = workforceCompanyId(env);
    const workforceUrl =
      `${baseUrl}/workforce?pageId=da_console_associates&station=ALL` +
      `&companyId=${encodeURIComponent(companyId)}&tabId=da-console-associates-tab`;

    await page.goto(entryUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

    const gate = await dismissSoftGates(page);
    if (!gate.ok) return gate;

    if (isSignInPage(page)) {
      const signedIn = await fillAmazonInSignIn(page, input.email, input.password);
      if (!signedIn.ok) return signedIn;
    }

    const postGate = await dismissSoftGates(page);
    if (!postGate.ok) return postGate;

    if (isSignInPage(page)) {
      return {
        ok: false,
        code: 'LOGIN_FAILED',
        error: 'Still on the Amazon sign-in page after submitting workforce credentials.',
      };
    }

    // Prefer workforce page so session cookies are scoped for DSP APIs.
    if (!page.url().includes('/workforce')) {
      await page.goto(workforceUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
      const afterWf = await dismissSoftGates(page);
      if (!afterWf.ok) return afterWf;
      if (isSignInPage(page)) {
        return {
          ok: false,
          code: 'LOGIN_FAILED',
          error: 'Redirected to sign-in when opening workforce — credentials may lack DSP access.',
        };
      }
    }

    const cookie = await collectWorkforceCookieHeader(page, baseUrl);
    if (!isWorkforceCookieComplete(cookie)) {
      // Wait briefly for Set-Cookie churn after first authenticated paint.
      const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
      let latest = cookie;
      while (Date.now() < deadline) {
        await sleep(1500);
        if (isSignInPage(page)) {
          return {
            ok: false,
            code: 'LOGIN_FAILED',
            error: 'Redirected to sign-in while capturing workforce cookies.',
          };
        }
        latest = await collectWorkforceCookieHeader(page, baseUrl);
        if (isWorkforceCookieComplete(latest)) {
          return { ok: true, auth: { cookie: latest } };
        }
      }
      return {
        ok: false,
        code: 'CAPTURE_TIMEOUT',
        error:
          `Captured workforce cookie looks incomplete (need session-token + at-acbin/sess-at-acbin). ` +
          `length=${latest.length}`,
      };
    }

    return { ok: true, auth: { cookie } };
  } catch (err) {
    return {
      ok: false,
      code: 'BROWSER_ERROR',
      error: `Workforce browser automation failed: ${(err as Error).message}`,
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
  return (
    url.includes('/ap/signin') ||
    url.includes('/ap/challenge') ||
    url.includes('/ap/mfa') ||
    /\/ap\?/.test(url)
  );
}

function isCaptchaPage(page: Page): boolean {
  const url = page.url();
  return url.includes('validateCaptcha') || url.includes('/errors/validateCaptcha');
}

/**
 * Soft bot gate Amazon sometimes shows before sign-in ("Continue shopping").
 */
async function dismissSoftGates(page: Page): Promise<{ ok: true } | WorkforceLoginResult> {
  for (let i = 0; i < 3; i++) {
    if (isCaptchaPage(page) || (await page.$('form[action*="validateCaptcha"]'))) {
      const btn = await page.$('button.a-button-text, form[action*="validateCaptcha"] button');
      if (!btn) {
        return {
          ok: false,
          code: 'CAPTCHA_REQUIRED',
          error:
            'Amazon showed a captcha / bot check that could not be auto-dismissed. ' +
            'Retry from a clean IP, use `npm run workforce:login -- --headed`, or upload cookies manually.',
        };
      }
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
        btn.click(),
      ]);
      await sleep(800);
      continue;
    }
    break;
  }

  if (isCaptchaPage(page) || (await page.$('#captchacharacters, form[action*="validateCaptcha"]'))) {
    return {
      ok: false,
      code: 'CAPTCHA_REQUIRED',
      error: 'Amazon captcha still present after Continue shopping.',
    };
  }

  return { ok: true };
}

/**
 * Amazon.in two-step: email → Continue → password → Sign in.
 */
async function fillAmazonInSignIn(
  page: Page,
  email: string,
  password: string,
): Promise<{ ok: true } | WorkforceLoginResult> {
  const emailSel = '#ap_email, #ap_email_login, input[name="email"], input[type="email"]';
  await page.waitForSelector(emailSel, { timeout: 30_000 });
  await page.click(emailSel, { clickCount: 3 });
  await page.type(emailSel, email, { delay: 25 });

  // Step 1 → Continue (required on modern Amazon.in)
  const continueClicked = await clickContinue(page);
  if (!continueClicked) {
    // Some pages show email+password together — fall through to password.
    const hasPasswordAlready = await page.$(passwordSelector());
    if (!hasPasswordAlready) {
      return {
        ok: false,
        code: 'LOGIN_FAILED',
        error: 'Could not find Continue after entering email on Amazon sign-in.',
      };
    }
  } else {
    await sleep(500);
  }

  await page.waitForSelector(passwordSelector(), { timeout: 30_000 });
  await page.click(passwordSelector(), { clickCount: 3 });
  await page.type(passwordSelector(), password, { delay: 25 });

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
    page.click('#signInSubmit, input#signInSubmit, button#signInSubmit, button[type="submit"]'),
  ]);

  await sleep(1500);

  if (await page.$('#auth-mfa-otpcode, #auth-mfa-form, input[name="otpCode"]')) {
    return {
      ok: false,
      code: 'MFA_REQUIRED',
      error:
        'Amazon requires MFA/OTP for this workforce account. Use an account without MFA, or upload a session cookie manually.',
    };
  }

  const gate = await dismissSoftGates(page);
  if (!gate.ok) return gate;

  if (isSignInPage(page)) {
    const alertText = await page
      .$eval('.a-alert-content, #auth-error-message-box, #auth-warning-message-box', (el) => {
        const node = el as unknown as { textContent?: string | null };
        return node.textContent?.trim() ?? '';
      })
      .catch(() => '');
    return {
      ok: false,
      code: 'LOGIN_FAILED',
      error: alertText
        ? `Amazon rejected the workforce login: ${alertText}`
        : 'Amazon workforce login did not leave the sign-in page. Check WORKFORCE_PORTAL_EMAIL / PASSWORD.',
    };
  }

  return { ok: true };
}

function passwordSelector(): string {
  return '#ap_password, input[name="password"], input[type="password"]';
}

async function clickContinue(page: Page): Promise<boolean> {
  const selectors = [
    '#continue',
    'input#continue',
    '#continue input',
    'button#continue',
    'span#continue input',
    'input.a-button-input[type="submit"]',
  ];

  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    // Prefer the visible Continue control on the email step.
    const visible = await page.evaluate((node) => {
      const el = node as {
        ownerDocument?: {
          defaultView?: {
            getComputedStyle: (n: unknown) => { display: string; visibility: string };
          };
        };
      };
      const view = el.ownerDocument?.defaultView;
      if (!view) return true;
      const style = view.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }, el);
    if (!visible) continue;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null),
      el.click(),
    ]);
    return true;
  }

  // Fallback: press Enter on email field
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null);
  return Boolean(await page.$(passwordSelector()));
}

function isWorkforceCookieComplete(cookie: string): boolean {
  const hasSession = cookie.includes('session-token=');
  const hasAt = cookie.includes('at-acbin=') || cookie.includes('sess-at-acbin=');
  return hasSession && hasAt && cookie.length > 80;
}

async function collectWorkforceCookieHeader(page: Page, baseUrl: string): Promise<string> {
  try {
    const client = await page.createCDPSession();
    const result = (await client.send('Network.getAllCookies')) as {
      cookies: Array<{ name: string; value: string; domain: string }>;
    };
    const relevant = result.cookies.filter((c) =>
      /amazon\.in|amazon\.com|logistics\.amazon/i.test(c.domain),
    );
    const byName = new Map<string, string>();
    // Prefer .amazon.in over .amazon.com when names collide.
    for (const c of relevant.sort((a, b) => {
      const score = (d: string) => (d.includes('amazon.in') ? 0 : 1);
      return score(a.domain) - score(b.domain);
    })) {
      if (!byName.has(c.name)) byName.set(c.name, c.value);
    }
    return Array.from(byName.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  } catch {
    const cookies = await page.cookies(baseUrl, 'https://www.amazon.in');
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
