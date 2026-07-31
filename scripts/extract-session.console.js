/**
 * How to use:
 * 1. Log into https://www.amazonlogistics.eu/station/... normally in Chrome.
 * 2. Open DevTools (F12) -> Console tab, on that same tab.
 * 3. Fill in WORKER_URL / ADMIN_KEY / UPLOADED_BY below, paste this whole
 *    file into the console, press Enter.
 * 4. Click anything in the dashboard that reloads data (e.g. switch station,
 *    refresh Cash Overview) — that's what fires a request to
 *    /station/proxyapigateway/data and gives us the x-api-usage-key header,
 *    which isn't stored anywhere readable (it's computed client-side on
 *    each request, not sitting in a cookie or localStorage).
 * 5. Watch the console: it logs "Session captured, uploading..." then
 *    either "Uploaded OK" or an error you can read and retry.
 *
 * This only needs to be re-run when the owner's dashboard notification (or
 * GET /api/admin/session/status) says the stored session is expired.
 */
(() => {
    const WORKER_URL = 'http://127.0.0.1:8787'; // <-- set this
    const ADMIN_KEY = '1dcb123aa9ce6e3567b07879a97a16305d4977104c8cb190970d1193dab9b465'; // <-- set this (same value as the worker's ADMIN_API_KEY secret)
    const UPLOADED_BY = 'josephmathew072@gmail.com'; // <-- who's uploading, for the audit trail
  
    const originalFetch = window.fetch;
    let done = false;
  
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input?.url ?? '';
  
      if (!done && url.includes('/station/proxyapigateway/data')) {
        done = true;
        window.fetch = originalFetch; // stop intercepting immediately
  
        const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        const xApiUsageKey =
          headers instanceof Headers
            ? headers.get('x-api-usage-key')
            : (headers && (headers['x-api-usage-key'] || headers['X-Api-Usage-Key'])) || null;
  
        if (!xApiUsageKey) {
          console.error('[extract-session] Could not find x-api-usage-key on this request. Try again on a different action.');
        } else {
          // document.cookie misses HttpOnly cookies. If validate still gets
          // HTML/401 after upload, replace cookie with the full Cookie header
          // from Network → proxyapigateway/data → Request Headers.
          const cookie = document.cookie;
          console.log(
            '[extract-session] cookie length:',
            cookie.length,
            '| session-token:',
            cookie.includes('session-token='),
            '| at-acbeu:',
            cookie.includes('at-acbeu='),
          );
          if (!cookie.includes('session-token=') || !cookie.includes('at-acbeu=')) {
            console.warn(
              '[extract-session] Cookie looks incomplete. Copy the Cookie header from Network and POST /api/admin/session manually.',
            );
          }

          console.log('[extract-session] Session captured, uploading...');
          try {
            const res = await originalFetch(`${WORKER_URL}/api/admin/session`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
              body: JSON.stringify({
                cookie,
                xApiUsageKey,
                uploadedBy: UPLOADED_BY,
              }),
            });
            const body = await res.json();
            if (res.ok) {
              console.log('[extract-session] Uploaded OK:', body);
            } else {
              console.error('[extract-session] Worker rejected upload:', res.status, body);
            }
          } catch (err) {
            console.error('[extract-session] Upload request failed:', err);
          }
        }
      }
  
      return originalFetch(input, init);
    };
  
    console.log('[extract-session] Listening for the next station-portal API call — click something in the dashboard now.');
  })();