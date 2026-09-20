import { WorkerEntrypoint } from 'cloudflare:workers';
import puppeteer, { type Page } from '@cloudflare/puppeteer';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types';
import { workforceCompanyId } from '../config';
import { timeoutFetch } from '../utils/timeoutFetch';
import { cookiesForAmazon,reconcileObservations,type PortalRow,type ProfileLink } from './observations';

type SyncStatus='ok'|'no_linked_profiles'|'login_required'|'layout_changed'|'unavailable';
type Result={status:SyncStatus|'busy';matched:number;missing:number};

// Named RPC entrypoint: callable only through a Cloudflare service binding.
// It is NOT registered as a public HTTP route and exposes no session/credential data.
export class AmazonOnboardingSource extends WorkerEntrypoint<Env> {
  async sync():Promise<Result> {
    const company=this.env.ONBOARDING_DROPX_COMPANY_ID;
    if(!company) throw new Error('Onboarding company scope is not configured');
    const db=createClient(this.env.SUPABASE_URL,this.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:timeoutFetch()}});
    const claim=await db.rpc('workforce_claim_amazon_sync',{p_company:company});
    if(claim.error) throw new Error('Onboarding schema or sync lease unavailable');
    if(!claim.data) return {status:'busy',matched:0,missing:0};
    const token=String(claim.data);
    let status:SyncStatus='unavailable';
    let observations:ReturnType<typeof reconcileObservations>['observations']=[];
    let missing=0;
    try {
      const connection=await db.rpc('workforce_read_amazon_connection',{p_company:company,p_token:token});
      if(connection.error||!connection.data) throw new Error('CONNECTION_UNAVAILABLE');
      let cookie=typeof connection.data.session==='string' ? connection.data.session : null;
      if(connection.data.login_requested) {
        // Consume the request before sign-in: crashes must not cause repeated login attempts.
        const consumed=await db.rpc('workforce_store_amazon_session',{p_company:company,p_token:token,p_cookie:null});
        if(consumed.error) throw new Error('CONNECTION_UNAVAILABLE');
        cookie=await login(this.env,connection.data.username,connection.data.password);
        const stored=await db.rpc('workforce_store_amazon_session',{p_company:company,p_token:token,p_cookie:cookie});
        if(stored.error) throw new Error('CONNECTION_UNAVAILABLE');
      }
      if(!cookie) throw new Error('LOGIN_REQUIRED');
      const links:ProfileLink[]=[];
      for(let offset=0;offset<5000;offset+=500) {
        const batch=await db.from('workforce_joining_plans').select('workforce_id,provider_profile_id').eq('company_id',company).not('provider_profile_id','is',null).is('closed_on',null).neq('provider_stage','withdrawn').order('workforce_id').range(offset,offset+499);
        if(batch.error) throw new Error('LINKS_UNAVAILABLE');
        links.push(...batch.data as ProfileLink[]);
        if(batch.data.length<500) break;
        if(offset===4500) throw new Error('LINK_LIMIT');
      }
      if(!links.length) status='no_linked_profiles';
      else {
        reconcileObservations(links,[]); // Validate identity uniqueness before external reads.
        const rows=await readOnboarding(this.env,cookie);
        ({observations,missing}=reconcileObservations(links,rows));
        status='ok';
      }
    } catch(error) {
      const code=error instanceof Error ? error.message : '';
      status=code==='LOGIN_REQUIRED' ? 'login_required' : code==='LAYOUT_CHANGED' ? 'layout_changed' : 'unavailable';
      // Do not log raw portal exceptions, session cookies, names, emails or documents.
      console.warn('amazon_onboarding_sync',status);
    }
    const saved=await db.rpc('workforce_finish_amazon_sync',{p_company:company,p_token:token,p_status:status,p_observations:observations,p_missing:missing});
    if(saved.error) throw new Error('Onboarding result was not saved; lease or profile link changed');
    return {status,matched:observations.length,missing};
  }
}

async function readOnboarding(env:Env,cookie:string):Promise<PortalRow[]> {
  if(!env.BROWSER) throw new Error('BROWSER_UNAVAILABLE');
  const browser=await puppeteer.launch(env.BROWSER);
  try {
    const page=await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setViewport({width:1440,height:900});
    await page.setCookie(...cookiesForAmazon(cookie));
    const url=new URL('https://logistics.amazon.in/workforce');
    url.search=new URLSearchParams({pageId:'da_console_onboarding',station:'ALL',companyId:workforceCompanyId(env),tabId:'da-console-onboarding-tab'}).toString();
    await page.goto(url.toString(),{waitUntil:'domcontentloaded',timeout:45000});
    const host=new URL(page.url()).hostname;
    if(host!=='logistics.amazon.in'||/\/ap\/|captcha|signin/i.test(page.url())) throw new Error('LOGIN_REQUIRED');
    try {await page.waitForSelector('table');} catch {throw new Error('LAYOUT_CHANGED');}
    const result:PortalRow[]=[];
    const deadline=Date.now()+100000;
    for(let index=0;index<100;index++) {
      if(Date.now()>deadline) throw new Error('SCAN_TIMEOUT');
      const scan=await page.evaluate(`(()=>{
        const tables=Array.from(document.querySelectorAll('table'));
        const table=tables.find(t=>/Name and ID/.test(t.innerText)&&/Progress/.test(t.innerText)&&/Status/.test(t.innerText));
        if(!table) return null;
        const rows=Array.from(table.querySelectorAll('tr')).flatMap(tr=>{
          const link=tr.querySelector('a[href*="/account-management/delivery-associates/detail/"]');
          if(!link) return [];
          const cells=Array.from(tr.querySelectorAll('td'));
          return [{profileId:link.pathname.split('/').pop()||'',progress:cells.at(-2)?.innerText.trim()||'',status:cells.at(-1)?.innerText.trim()||''}];
        });
        const next=Array.from(document.querySelectorAll('button')).find(b=>/^Go to next page, page \\d+$/.test(b.getAttribute('aria-label')||''));
        return {rows,next:next&&!next.disabled&&next.getAttribute('aria-disabled')!=='true' ? next.getAttribute('aria-label'):null};
      })()` ) as {rows:PortalRow[];next:string|null}|null;
      if(!scan||!scan.rows.length) throw new Error('LAYOUT_CHANGED');
      result.push(...scan.rows);
      if(!scan.next) return result;
      const previous=scan.rows[0]!.profileId;
      await page.click(`button[aria-label="${scan.next}"]`);
      try {
        await page.waitForFunction(`(()=>{const a=document.querySelector('table a[href*="/account-management/delivery-associates/detail/"]');return a&&!a.pathname.endsWith(${JSON.stringify(previous)});})()`,{timeout:15000});
      } catch {throw new Error('LAYOUT_CHANGED');}
    }
    throw new Error('LAYOUT_CHANGED');
  } finally {await browser.close();}
}

async function requireNoChallenge(page:Page) {
  if(/captcha|\/ap\/(mfa|challenge)/i.test(page.url())||await page.$('#captchacharacters, #auth-mfa-otpcode, input[name="otpCode"], form[action*="validateCaptcha"]')) throw new Error('LOGIN_REQUIRED');
  if(!['logistics.amazon.in','www.amazon.in','amazon.in'].includes(new URL(page.url()).hostname)) throw new Error('LOGIN_REQUIRED');
}

async function login(env:Env,email:string,password:string):Promise<string> {
  if(!env.BROWSER||!email||!password) throw new Error('LOGIN_REQUIRED');
  const browser=await puppeteer.launch(env.BROWSER);
  try {
    const page=await browser.newPage();
    await page.goto('https://logistics.amazon.in/workforce',{waitUntil:'domcontentloaded',timeout:30000});
    await requireNoChallenge(page);
    const emailSelector='#ap_email, #ap_email_login, input[name="email"]';
    await page.waitForSelector(emailSelector,{timeout:10000});
    await page.type(emailSelector,email);
    if(!await page.$('#ap_password')) {
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:15000}).catch(()=>null),page.click('#continue')]);
    }
    await requireNoChallenge(page);
    await page.waitForSelector('#ap_password',{timeout:10000});
    await page.type('#ap_password',password);
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded',timeout:25000}).catch(()=>null),page.click('#signInSubmit')]);
    await requireNoChallenge(page);
    if(/\/ap\//.test(page.url())) throw new Error('LOGIN_REQUIRED');
    await page.goto('https://logistics.amazon.in/workforce',{waitUntil:'domcontentloaded',timeout:20000});
    await requireNoChallenge(page);
    if(new URL(page.url()).hostname!=='logistics.amazon.in'||/\/ap\//.test(page.url())) throw new Error('LOGIN_REQUIRED');
    const cookies=await page.cookies('https://logistics.amazon.in');
    const result=cookies.map(c=>`${c.name}=${c.value}`).join('; ');
    if(!result.includes('session-token=')||result.length<80) throw new Error('LOGIN_REQUIRED');
    return result;
  } catch {throw new Error('LOGIN_REQUIRED');}
  finally {await browser.close();}
}
