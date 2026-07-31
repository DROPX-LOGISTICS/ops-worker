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
    const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev'; // <-- set this
    const ADMIN_KEY = 'your-ADMIN_API_KEY-value'; // <-- set this (same value as the worker's ADMIN_API_KEY secret)
    const UPLOADED_BY = 'owner@yourcompany.com'; // <-- who's uploading, for the audit trail
  
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
          console.log('[extract-session] Session captured, uploading...');
          try {
            const res = await originalFetch(`${WORKER_URL}/api/admin/session`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY },
              body: JSON.stringify({
                cookie: document.cookie,
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