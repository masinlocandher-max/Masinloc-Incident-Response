import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const DB=process.env.LOCAL_DB_URL||'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ENDPOINT=process.env.LOCAL_EDGE_URL||'http://127.0.0.1:54321/functions/v1/emergency-response';
const ORIGIN='https://www.masinloc-zambales.com';
const failures=[];
const fail=m=>failures.push(m);

function sql(query,{expectFail=false}={}){
  try{
    const out=execFileSync('psql',[DB,'-qAt','-v','ON_ERROR_STOP=1','-c',query],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    if(expectFail)fail(`SQL unexpectedly succeeded: ${query.slice(0,90)}…`);
    return out;
  }catch(error){
    if(expectFail)return String(error.stderr||error.message||'');
    throw error;
  }
}

function localSupabaseEnv(){
  const raw=execFileSync('supabase',['status','-o','env'],{encoding:'utf8'});
  const env={};
  for(const line of raw.split(/\r?\n/)){
    const m=line.match(/^([A-Z0-9_]+)=(.*)$/);
    if(!m)continue;
    let value=m[2].trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    env[m[1]]=value;
  }
  return env;
}

async function api(payload,token=null){
  const headers={'content-type':'application/json','origin':ORIGIN};
  if(token)headers.authorization=`Bearer ${token}`;
  const r=await fetch(ENDPOINT,{method:'POST',headers,body:JSON.stringify(payload)});
  const body=await r.json().catch(()=>({}));
  return {status:r.status,body};
}

function report(mode,agency,label='Local CI'){
  return {
    client_report_id:crypto.randomUUID(),
    report_secret:crypto.randomBytes(40).toString('base64url'),
    target_agency:agency,
    report_mode:mode,
    incident_type:mode==='assistance'?'suspicious_activity':'threat',
    description:`${label} ${mode} report`,
    reporter_name:null,
    reporter_contact:null,
    contact_preference:'chat',
    latitude:15.536321,
    longitude:119.952441,
    accuracy_m:12,
    location_captured_at:new Date().toISOString(),
    barangay:'QA Barangay',
    landmark:'QA Landmark',
    source_created_at:new Date().toISOString()
  };
}

async function createLocalAuthSession(){
  const env=localSupabaseEnv();
  const base=env.API_URL||'http://127.0.0.1:54321';
  const anon=env.ANON_KEY;
  if(!anon)throw new Error('Supabase local ANON_KEY not found in `supabase status -o env`.');
  const email=`edge-reporter-${Date.now()}-${crypto.randomUUID().slice(0,8)}@example.invalid`;
  const password=`Ci-${crypto.randomBytes(18).toString('base64url')}!9a`;
  const common={
    'content-type':'application/json',
    'apikey':anon,
    'authorization':`Bearer ${anon}`
  };
  let r=await fetch(`${base}/auth/v1/signup`,{method:'POST',headers:common,body:JSON.stringify({email,password})});
  let body=await r.json().catch(()=>({}));
  if(!body.access_token){
    r=await fetch(`${base}/auth/v1/token?grant_type=password`,{method:'POST',headers:common,body:JSON.stringify({email,password})});
    body=await r.json().catch(()=>({}));
  }
  if(!body.access_token||!body.user?.id)throw new Error(`Could not obtain local auth session: ${r.status} ${JSON.stringify(body)}`);
  return {token:body.access_token,userId:body.user.id,email};
}

// Production-equivalent shared dependency used by the Edge Function.
sql("\\i scripts/local-emergency-bootstrap.sql");

// Schema and privilege invariants.
const migrationChecks=sql(`
select json_build_object(
  'reporter_column', exists(select 1 from information_schema.columns where table_schema='public' and table_name='emergency_incidents' and column_name='reporter_user_id'),
  'report_mode_column', exists(select 1 from information_schema.columns where table_schema='public' and table_name='emergency_incidents' and column_name='report_mode'),
  'reporter_policy', exists(select 1 from pg_policies where schemaname='public' and tablename='emergency_incidents' and policyname='emergency_incidents_reporter_read'),
  'member_cap_trigger', exists(select 1 from pg_trigger where tgname='emergency_agency_member_limit_guard' and not tgisinternal),
  'trigger_anon_blocked', not has_function_privilege('anon','public.emergency_freeze_resident_fields()','EXECUTE'),
  'trigger_auth_blocked', not has_function_privilege('authenticated','public.emergency_freeze_resident_fields()','EXECUTE'),
  'trigger_service_allowed', has_function_privilege('service_role','public.emergency_freeze_resident_fields()','EXECUTE'),
  'status_update_allowed', has_column_privilege('authenticated','public.emergency_incidents','status','UPDATE'),
  'description_update_blocked', not has_column_privilege('authenticated','public.emergency_incidents','description','UPDATE'),
  'reporter_user_update_blocked', not has_column_privilege('authenticated','public.emergency_incidents','reporter_user_id','UPDATE')
)::text;`);
const inv=JSON.parse(migrationChecks);
for(const [k,v] of Object.entries(inv))if(v!==true)fail(`schema invariant failed: ${k}`);

// Seed three auth identities and deterministic incidents for RLS tests.
const PNP='11111111-1111-4111-8111-111111111111';
const MDR='22222222-2222-4222-8222-222222222222';
const REPORTER='33333333-3333-4333-8333-333333333333';
const IPNP='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IMDR='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IOWN='cccccccc-cccc-4ccc-8ccc-cccccccccccc';

sql(`
insert into auth.users(id,aud,role,email,created_at,updated_at)
values
('${PNP}','authenticated','authenticated','pnp-ci@example.invalid',now(),now()),
('${MDR}','authenticated','authenticated','mdrrmo-ci@example.invalid',now(),now()),
('${REPORTER}','authenticated','authenticated','resident-ci@example.invalid',now(),now())
on conflict (id) do nothing;
insert into public.emergency_agency_members(user_id,agency,role,active)
values ('${PNP}','pnp','operator',true),('${MDR}','mdrrmo','operator',true)
on conflict (user_id,agency) do update set active=true;
insert into public.emergency_incidents(id,client_report_id,public_reference,report_secret_hash,target_agency,lead_agency,report_mode,incident_type,description,source_created_at,reporter_user_id)
values
('${IPNP}',gen_random_uuid(),'CI-PNP','x','pnp','pnp','emergency','threat','PNP only',now(),null),
('${IMDR}',gen_random_uuid(),'CI-MDR','x','mdrrmo','mdrrmo','emergency','flood','MDRRMO only',now(),null),
('${IOWN}',gen_random_uuid(),'CI-OWN','x','pnp','pnp','assistance','other','Resident own',now(),'${REPORTER}')
on conflict (id) do nothing;
insert into public.emergency_incident_agencies(incident_id,agency,relationship)
values ('${IPNP}','pnp','primary'),('${IMDR}','mdrrmo','primary'),('${IOWN}','pnp','primary')
on conflict (incident_id,agency) do nothing;
insert into public.emergency_messages(incident_id,sender_kind,sender_agency,visibility,body)
values ('${IOWN}','system',null,'public','Public update'),('${IOWN}','pnp','pnp','internal','Internal note');
`);

function asUser(userId,query){
  return sql(`set role authenticated; set request.jwt.claims='{"sub":"${userId}","role":"authenticated"}'; ${query}`);
}

const uidCheck=asUser(PNP,'select auth.uid();');
if(uidCheck!==PNP)fail(`auth.uid() context was not established; expected ${PNP}, got ${JSON.stringify(uidCheck)}`);

const pnpCount=asUser(PNP,'select count(*) from public.emergency_incidents;');
if(pnpCount!=='2')fail(`PNP RLS did not expose exactly PNP-linked incidents; got ${JSON.stringify(pnpCount)}`);
const mdrCount=asUser(MDR,'select count(*) from public.emergency_incidents;');
if(mdrCount!=='1')fail(`MDRRMO RLS did not isolate MDRRMO-linked incidents; got ${JSON.stringify(mdrCount)}`);
const reporterCount=asUser(REPORTER,'select count(*) from public.emergency_incidents;');
if(reporterCount!=='1')fail(`Reporter RLS did not expose exactly the resident-owned incident; got ${JSON.stringify(reporterCount)}`);
const reporterMessageCount=asUser(REPORTER,`select count(*) from public.emergency_messages where incident_id='${IOWN}';`);
if(reporterMessageCount!=='1')fail(`Reporter public-message RLS expected 1 visible message, got ${JSON.stringify(reporterMessageCount)}`);

// Resident-authored fields are protected twice: column grants keep them out of
// the responder UPDATE surface, and the trigger freezes them if a privileged
// path ever reaches the row.
const frozenErr=sql(`set role authenticated; set request.jwt.claims='{"sub":"${PNP}","role":"authenticated"}'; update public.emergency_incidents set description='tampered' where id='${IPNP}';`,{expectFail:true});
if(!/(permission denied for table emergency_incidents|cannot change description|resident.*own report|check_violation)/i.test(frozenErr))fail(`Responder resident-field rewrite was not denied as expected; error was ${JSON.stringify(frozenErr.slice(0,500))}`);

asUser(PNP,`update public.emergency_incidents set status='acknowledged' where id='${IPNP}';`);
if(sql(`select count(*) from public.emergency_events where incident_id='${IPNP}' and event_type='status_changed';`)!=='1')fail('Status audit event was not recorded');

const adminErr=sql(`set role authenticated; set request.jwt.claims='{"sub":"${PNP}","role":"authenticated"}'; select * from public.emergency_activate_member('resident-ci@example.invalid','pnp','operator',null);`,{expectFail:true});
if(!/platform administrator/i.test(adminErr))fail(`Responder activation helper did not enforce platform-admin authorization; error was ${JSON.stringify(adminErr.slice(0,500))}`);

// The public readiness action says only whether each desk has any active
// responder. It must not disclose names, roles, e-mails or counts.
const readiness=await api({action:'readiness'});
if(readiness.status!==200||readiness.body?.determined!==true||readiness.body?.staffed?.pnp!==true||readiness.body?.staffed?.mdrrmo!==true)fail(`Readiness did not reflect the seeded staffed desks: ${readiness.status} ${JSON.stringify(readiness.body)}`);
const readinessKeys=Object.keys(readiness.body||{}).sort().join(',');
if(readinessKeys!=='determined,ok,staffed')fail(`Readiness exposed unexpected top-level data: ${readinessKeys}`);
if(Object.keys(readiness.body?.staffed||{}).sort().join(',')!=='mdrrmo,pnp')fail('Readiness staffed object exposed fields beyond pnp/mdrrmo booleans');

// Hard database cap: the existing PNP member plus nine more is allowed; the
// 11th active PNP responder must be rejected even through direct SQL.
sql(`
do $$
declare i integer; v uuid;
begin
  for i in 1..9 loop
    v := gen_random_uuid();
    insert into auth.users(id,aud,role,email,created_at,updated_at)
      values(v,'authenticated','authenticated','pnp-cap-'||i||'@example.invalid',now(),now());
    insert into public.emergency_agency_members(user_id,agency,role,active)
      values(v,'pnp','operator',true);
  end loop;
end $$;
`);
if(sql("select count(*) from public.emergency_agency_members where agency='pnp' and active;")!=='10')fail('PNP responder cap setup did not reach exactly 10 active accounts');
const capErr=sql(`
do $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users(id,aud,role,email,created_at,updated_at)
    values(v,'authenticated','authenticated','pnp-cap-11@example.invalid',now(),now());
  insert into public.emergency_agency_members(user_id,agency,role,active)
    values(v,'pnp','operator',true);
end $$;
`,{expectFail:true});
if(!/maximum of 10 active responder accounts/i.test(capErr))fail(`11th active responder was not rejected by the database cap: ${JSON.stringify(capErr.slice(0,500))}`);

// Anonymous resident lifecycle remains the baseline contract.
const urgent=report('emergency','pnp');
const urgentSubmit=await api({action:'submit',report:urgent});
if(urgentSubmit.status!==201||!urgentSubmit.body.ok||urgentSubmit.body.attributed!==false)fail(`Anonymous Emergency submit failed or was falsely attributed: ${urgentSubmit.status} ${JSON.stringify(urgentSubmit.body)}`);
if(sql(`select report_mode from public.emergency_incidents where client_report_id='${urgent.client_report_id}';`)!=='emergency')fail('Emergency report_mode was not persisted as emergency');
if(sql(`select reporter_user_id is null from public.emergency_incidents where client_report_id='${urgent.client_report_id}';`)!=='t')fail('Anonymous Emergency report unexpectedly received reporter_user_id');

const assistance=report('assistance','mdrrmo');
const assistanceSubmit=await api({action:'submit',report:assistance});
if(assistanceSubmit.status!==201||!assistanceSubmit.body.ok||assistanceSubmit.body.attributed!==false)fail(`Anonymous Assistance submit failed or was falsely attributed: ${assistanceSubmit.status} ${JSON.stringify(assistanceSubmit.body)}`);
if(sql(`select report_mode from public.emergency_incidents where client_report_id='${assistance.client_report_id}';`)!=='assistance')fail('Assistance report_mode was not persisted as assistance');

const duplicate=await api({action:'submit',report:urgent});
if(duplicate.status!==200||duplicate.body.duplicate!==true)fail('Duplicate submit was not idempotent');
if(sql(`select count(*) from public.emergency_incidents where client_report_id='${urgent.client_report_id}';`)!=='1')fail('Duplicate submit created more than one incident');

const conflict=await api({action:'submit',report:{...urgent,report_secret:crypto.randomBytes(40).toString('base64url')}});
if(conflict.status!==409)fail(`Changed-secret duplicate did not return conflict; got ${conflict.status}`);

const status=await api({action:'status',client_report_id:assistance.client_report_id,report_secret:assistance.report_secret});
if(status.status!==200||status.body?.incident?.report_mode!=='assistance')fail('Status endpoint did not return persisted assistance mode');

const messageId=crypto.randomUUID();
const message=await api({action:'message',client_report_id:urgent.client_report_id,report_secret:urgent.report_secret,client_message_id:messageId,message:'Local CI resident follow-up'});
if(message.status!==201||!message.body.ok)fail('Resident message endpoint failed');

const wrong=await api({action:'status',client_report_id:urgent.client_report_id,report_secret:crypto.randomBytes(40).toString('base64url')});
if(wrong.status!==404)fail(`Wrong report secret should be indistinguishable from not-found; got ${wrong.status}`);

// Optional signed-in attribution: a valid token attaches exactly that user to
// the report. An invalid token must degrade to anonymous instead of blocking
// an emergency report.
let session=null;
try{session=await createLocalAuthSession()}catch(error){fail(error instanceof Error?error.message:String(error))}
if(session){
  const linked=report('emergency','mdrrmo','Local CI signed-in');
  const linkedSubmit=await api({action:'submit',report:linked},session.token);
  if(linkedSubmit.status!==201||linkedSubmit.body.attributed!==true)fail(`Valid signed-in report was not attributed: ${linkedSubmit.status} ${JSON.stringify(linkedSubmit.body)}`);
  const linkedUser=sql(`select reporter_user_id::text from public.emergency_incidents where client_report_id='${linked.client_report_id}';`);
  if(linkedUser!==session.userId)fail(`Signed-in report linked to ${linkedUser||'NULL'}, expected ${session.userId}`);

  const stale=report('assistance','pnp','Local CI stale-token');
  const staleSubmit=await api({action:'submit',report:stale},'invalid.expired.token');
  if(staleSubmit.status!==201||staleSubmit.body.attributed!==false)fail(`Invalid token blocked reporting or falsely attributed it: ${staleSubmit.status} ${JSON.stringify(staleSubmit.body)}`);
  if(sql(`select reporter_user_id is null from public.emergency_incidents where client_report_id='${stale.client_report_id}';`)!=='t')fail('Invalid-token report was not stored anonymously');
}

if(failures.length){
  console.error(`Local Supabase emergency QA failed (${failures.length}):`);
  failures.forEach(x=>console.error(` - ${x}`));
  process.exit(1);
}
console.log('Local Supabase emergency QA passed: seven-migration schema, agency/reporter RLS, responder cap, immutable resident fields, audit events, readiness privacy, anonymous lifecycle, signed-in attribution fallback, duplicate idempotency, and emergency/assistance persistence verified.');
