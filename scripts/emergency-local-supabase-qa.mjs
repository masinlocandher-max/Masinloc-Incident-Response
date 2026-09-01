import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const DB=process.env.LOCAL_DB_URL||'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ENDPOINT=process.env.LOCAL_EDGE_URL||'http://127.0.0.1:54321/functions/v1/emergency-response';
const ORIGIN='https://www.masinloc-zambales.com';
const failures=[];
const fail=m=>failures.push(m);

function sql(query,{expectFail=false}={}){
  try{
    // -q suppresses command-status noise such as SET/UPDATE. Without it,
    // a correct RLS count is returned as "SET\nSET\n2" and an exact-value
    // assertion falsely reports a policy failure.
    const out=execFileSync('psql',[DB,'-qAt','-v','ON_ERROR_STOP=1','-c',query],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    if(expectFail)fail(`SQL unexpectedly succeeded: ${query.slice(0,90)}…`);
    return out;
  }catch(error){
    if(expectFail)return String(error.stderr||error.message||'');
    throw error;
  }
}

async function api(payload){
  const r=await fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','origin':ORIGIN},body:JSON.stringify(payload)});
  const body=await r.json().catch(()=>({}));
  return {status:r.status,body};
}

function report(mode,agency){
  return {
    client_report_id:crypto.randomUUID(),
    report_secret:crypto.randomBytes(40).toString('base64url'),
    target_agency:agency,
    report_mode:mode,
    incident_type:mode==='assistance'?'suspicious_activity':'threat',
    description:`Local CI ${mode} report`,
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

// Production-equivalent shared dependency used by the Edge Function.
sql("\\i scripts/local-emergency-bootstrap.sql");

// Schema and privilege invariants.
const migrationChecks=sql(`
select json_build_object(
  'reporter_column', exists(select 1 from information_schema.columns where table_schema='public' and table_name='emergency_incidents' and column_name='reporter_user_id'),
  'report_mode_column', exists(select 1 from information_schema.columns where table_schema='public' and table_name='emergency_incidents' and column_name='report_mode'),
  'reporter_policy', exists(select 1 from pg_policies where schemaname='public' and tablename='emergency_incidents' and policyname='emergency_incidents_reporter_read'),
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

// Before interpreting any RLS result, prove our local session emulates the
// authenticated user's auth.uid() exactly as PostgREST does.
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

// The hardening migration intentionally grants responders UPDATE only on
// operational columns. A resident-authored field may therefore be stopped by
// column privilege before the freeze trigger runs. Either mechanism is a valid
// denial; the invariant above separately proves description/reporter_user_id
// are not update-granted while status is.
const frozenErr=sql(`set role authenticated; set request.jwt.claims='{"sub":"${PNP}","role":"authenticated"}'; update public.emergency_incidents set description='tampered' where id='${IPNP}';`,{expectFail:true});
if(!/(permission denied for table emergency_incidents|cannot change description|resident.*own report|check_violation)/i.test(frozenErr))fail(`Responder resident-field rewrite was not denied as expected; error was ${JSON.stringify(frozenErr.slice(0,500))}`);

asUser(PNP,`update public.emergency_incidents set status='acknowledged' where id='${IPNP}';`);
if(sql(`select count(*) from public.emergency_events where incident_id='${IPNP}' and event_type='status_changed';`)!=='1')fail('Status audit event was not recorded');

const adminErr=sql(`set role authenticated; set request.jwt.claims='{"sub":"${PNP}","role":"authenticated"}'; select * from public.emergency_activate_member('resident-ci@example.invalid','pnp','operator',null);`,{expectFail:true});
if(!/platform administrator/i.test(adminErr))fail(`Responder activation helper did not enforce platform-admin authorization; error was ${JSON.stringify(adminErr.slice(0,500))}`);

// Edge Function lifecycle using anonymous resident contract.
const urgent=report('emergency','pnp');
const urgentSubmit=await api({action:'submit',report:urgent});
if(urgentSubmit.status!==201||!urgentSubmit.body.ok)fail(`Emergency submit failed: ${urgentSubmit.status} ${JSON.stringify(urgentSubmit.body)}`);
if(sql(`select report_mode from public.emergency_incidents where client_report_id='${urgent.client_report_id}';`)!=='emergency')fail('Emergency report_mode was not persisted as emergency');

const assistance=report('assistance','mdrrmo');
const assistanceSubmit=await api({action:'submit',report:assistance});
if(assistanceSubmit.status!==201||!assistanceSubmit.body.ok)fail(`Assistance submit failed: ${assistanceSubmit.status} ${JSON.stringify(assistanceSubmit.body)}`);
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

if(failures.length){
  console.error(`Local Supabase emergency QA failed (${failures.length}):`);
  failures.forEach(x=>console.error(` - ${x}`));
  process.exit(1);
}
console.log('Local Supabase emergency QA passed: six-migration schema, RLS boundaries, immutable resident fields, audit events, anonymous lifecycle, duplicate idempotency, and emergency/assistance persistence verified.');
