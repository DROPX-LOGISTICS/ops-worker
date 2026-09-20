interface Bindings { ONBOARDING_SOURCE:{sync():Promise<{status:string;matched:number;missing:number}>} }
export default {
  async fetch(request:Request):Promise<Response> {
    if(request.method!=='GET'||new URL(request.url).pathname!=='/health') return new Response('Not found',{status:404});
    return Response.json({service:'amazon-onboarding-worker',mode:'read-only-provider-observations',schedule:'every 30 minutes',invitesAutomated:false},{headers:{'Cache-Control':'no-store'}});
  },
  async scheduled(_event:ScheduledEvent,env:Bindings,ctx:ExecutionContext) {
    ctx.waitUntil(env.ONBOARDING_SOURCE.sync().then(result=>{
      console.log('amazon_onboarding_result',JSON.stringify(result));
      if(!['ok','no_linked_profiles','busy'].includes(result.status)) throw new Error(`Onboarding requires attention: ${result.status}`);
    }));
  }
};
