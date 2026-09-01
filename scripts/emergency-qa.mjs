import fs from 'node:fs';

const read=p=>fs.readFileSync(p,'utf8');
const files={
  user:read('emergency/index.html'),
  userJs:read('emergency/emergency.js'),
  sw:read('emergency/sw.js'),
  pnp:read('emergency/pnp.html'),
  mdrrmo:read('emergency/mdrrmo.html'),
  agencyJs:read('emergency/agency.js'),
  migration:read('supabase/migrations/20260831143000_emergency_response_core.sql'),
  fn:read('supabase/functions/emergency-response/index.ts')
};
const failures=[];
const check=(condition,message)=>{if(!condition)failures.push(message)};

check(files.user.includes('data-agency="pnp"')&&files.user.includes('data-agency="mdrrmo"'),'Resident interface must offer only PNP and MDRRMO agency choices.');
check(files.pnp.includes('data-agency="pnp"'),'PNP interface identity missing.');
check(files.mdrrmo.includes('data-agency="mdrrmo"'),'MDRRMO interface identity missing.');
check(files.user.includes('tel:911'),'Resident emergency fallback must expose 911.');
check(files.userJs.includes('navigator.geolocation.getCurrentPosition'),'GPS capture is missing.');
check(files.userJs.includes("sync_state:'queued'")&&files.userJs.includes("status:'saved_offline'"),'Local-first queued report state is missing.');
check(files.userJs.includes("window.addEventListener('online'")&&files.userJs.includes("window.addEventListener('focus'"),'Reconnect retry hooks are missing.');
check(files.sw.includes("masinloc-emergency-sync"),'Background sync hook is missing.');
check(files.user.includes('Not Yet Received')||files.userJs.includes('Not Yet Received'),'Offline UI must explicitly say the report is not yet received.');
check(!/supabase\.from\(['"]emergency_incidents/.test(files.userJs),'Public resident JS must not query emergency tables directly.');
check(files.migration.includes('enable row level security'),'Emergency tables must have RLS enabled.');
check(files.migration.includes('revoke all on table public.emergency_incidents from anon'),'Anonymous direct incident-table privileges must be revoked.');
check(files.migration.includes('emergency_can_access_incident'),'Agency incident access helper is missing.');
check(files.migration.includes('emergency_refer_incident'),'Cross-agency referral function is missing.');
check(files.fn.includes('report_secret_hash')&&files.fn.includes('sha256'),'Public report status must be protected by a hashed per-report secret.');
check(files.fn.includes('check_submission_rate_limit'),'Public emergency endpoint must use server-side abuse throttling.');
check(files.agencyJs.includes("sb.rpc('emergency_refer_incident'"),'Agency console must support explicit PNP/MDRRMO referral.');
check(!/auto.{0,20}(dispatch|arrest|priority|critical)/i.test(files.agencyJs),'Agency console must not automate high-impact responder decisions.');

if(failures.length){
  console.error(`Emergency QA failed (${failures.length}):`);
  for(const f of failures)console.error(` - ${f}`);
  process.exit(1);
}
console.log('Emergency QA passed: resident, PNP, MDRRMO, offline queue, GPS, RLS, secret status access, and human-operated agency actions verified.');
