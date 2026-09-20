export type PortalRow = {profileId:string; progress:string; status:string};
export type ProfileLink = {workforce_id:string; provider_profile_id:string};
export const profilePattern=/^amzn1\.flex\.provider\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// No fuzzy name/email matching and no inference that disappearing means active.
export function reconcileObservations(links:ProfileLink[],rows:PortalRow[]) {
  const seen=new Set<string>();
  for(const link of links) {
    if(!profilePattern.test(link.provider_profile_id)||seen.has(link.provider_profile_id)) throw new Error('INVALID_PROFILE_LINKS');
    seen.add(link.provider_profile_id);
  }
  const byId=new Map<string,PortalRow>();
  for(const row of rows) {
    if(!profilePattern.test(row.profileId)||!row.progress.trim()||!row.status.trim()||row.progress.length>300||row.status.length>1000||byId.has(row.profileId)) throw new Error('LAYOUT_CHANGED');
    byId.set(row.profileId,row);
  }
  const observations=links.flatMap(link=>{
    const row=byId.get(link.provider_profile_id);
    return row ? [{...link,progress:row.progress,provider_status:row.status}]:[];
  });
  return {observations,missing:links.length-observations.length};
}

export function cookiesForAmazon(header:string) {
  return header.split(';').map(part=>{
    const i=part.indexOf('=');
    if(i<=0) return null;
    return {name:part.slice(0,i).trim(),value:part.slice(i+1).trim(),url:'https://logistics.amazon.in',secure:true};
  }).filter((cookie):cookie is NonNullable<typeof cookie>=>Boolean(cookie?.name));
}
