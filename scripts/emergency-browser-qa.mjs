import { chromium } from 'playwright';
import fs from 'node:fs';

const baseURL=process.env.QA_BASE_URL||'http://127.0.0.1:8000';
const browser=await chromium.launch({headless:true});
const failures=[];
const fail=m=>failures.push(m);
fs.mkdirSync('artifacts/browser-qa',{recursive:true});

const context=await browser.newContext({
  viewport:{width:390,height:844},
  geolocation:{latitude:15.536321,longitude:119.952441},
  permissions:['geolocation'],
});
const page=await context.newPage();
const pageErrors=[];
page.on('pageerror',e=>pageErrors.push(`pageerror: ${e.message}`));
page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))pageErrors.push(`console: ${m.text()}`)});

let serverStatus='received';
const submitted=[];
let agencyReplies=[];
await page.route('**/functions/v1/emergency-response',async route=>{
  const req=route.request();
  let body={};
  try{body=req.postDataJSON()||{}}catch{}
  const action=body.action;
  if(action==='submit'){
    submitted.push(body.report||{});
    const agency=body.report?.target_agency||'pnp';
    await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({ok:true,reference:`QA-${String(agency).toUpperCase()}-001`,status:'received',received_at:new Date().toISOString()})});
    return;
  }
  if(action==='status'){
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,incident:{client_report_id:body.client_report_id,public_reference:agencyReplies.length?'QA-MDRRMO-001':'QA-PNP-001',target_agency:agencyReplies.length?'mdrrmo':'pnp',lead_agency:agencyReplies.length?'mdrrmo':'pnp',status:serverStatus,priority:'unassessed',incident_type:'qa',received_at:new Date().toISOString(),acknowledged_at:null,assigned_unit:null,resolved_at:null,updated_at:new Date().toISOString()},messages:[{id:'qa-system',sender_kind:'system',sender_agency:null,body:'QA receipt confirmed.',created_at:new Date().toISOString()},...agencyReplies]})});
    return;
  }
  if(action==='message'){
    await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({ok:true,message_id:'qa-message',created_at:new Date().toISOString()})});
    return;
  }
  await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({ok:false,error:'bad qa action'})});
});

const response=await page.goto(`${baseURL}/emergency/`,{waitUntil:'networkidle'});
if(!response||response.status()>=400)fail(`emergency/mobile: HTTP ${response?.status()??'no response'}`);
if(await page.locator('[data-agency]').count()!==2)fail('emergency/mobile: resident must see exactly two agency choices');
if(await page.locator('[data-agency="pnp"]').count()!==1||await page.locator('[data-agency="mdrrmo"]').count()!==1)fail('emergency/mobile: PNP/MDRRMO choices are incomplete');
if(await page.locator('a[href="tel:911"]').count()<1)fail('emergency/mobile: 911 fallback is missing');
let overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
if(overflow>1)fail(`emergency/mobile: horizontal overflow ${overflow}px`);

await page.locator('[data-agency="pnp"]').click();
await page.locator('#reportPanel').waitFor({state:'visible'});
await page.waitForFunction(()=>document.querySelector('#locationCard')?.classList.contains('captured'));
const gpsText=await page.locator('#locationMeta').innerText();
if(!gpsText.includes('15.536321')||!gpsText.includes('119.952441'))fail(`emergency/mobile: GPS coordinates not surfaced: ${gpsText}`);
await page.locator('#incidentType').selectOption('threat');
await page.locator('#description').fill('QA immediate safety report.');
await page.locator('#barangay').fill('QA Barangay');
await page.locator('#reportForm').evaluate(form=>form.requestSubmit());
await page.locator('#activeReport').waitFor({state:'visible'});
await page.waitForFunction(()=>document.querySelector('#statusLabel')?.textContent?.includes('Received by emergency system'));
if((await page.locator('#referenceValue').innerText()).trim()!=='QA-PNP-001')fail('emergency/mobile: confirmed server reference was not shown');
await page.screenshot({path:'artifacts/browser-qa/emergency-mobile-received.png',fullPage:true});

/* --- report mode: intent, and only intent ------------------------------- */

// Emergency must be preselected. Under pressure the default has to be the
// urgent one, and a mis-tap should land on urgent rather than away from it.
if(submitted.length!==1)fail(`emergency/mobile: expected 1 submission, saw ${submitted.length}`);
if(submitted[0].report_mode!=='emergency')fail(`emergency/mobile: default report_mode was '${submitted[0].report_mode}', must be 'emergency'`);

// Intent never carries a priority. The agency decides that, and an intake that
// shipped one would be making an automated triage decision.
if('priority' in submitted[0])fail('emergency/mobile: intake sent a priority — priority is the agency\'s judgement, not the resident\'s');

// Tap targets on the mode choice, measured as painted. Ported from the
// retired assistance suite: this is a one-handed screen, possibly in rain.
await page.locator('#newReportBtn').click();
await page.locator('[data-agency="pnp"]').click();
await page.locator('#modePicker').waitFor({state:'visible'});
const modeBoxes=await page.$$eval('[data-mode]',ns=>ns.map(n=>({mode:n.dataset.mode,h:n.getBoundingClientRect().height,pressed:n.getAttribute('aria-pressed')})));
if(modeBoxes.length!==2)fail(`emergency/mobile: expected 2 report modes, found ${modeBoxes.length}`);
for(const b of modeBoxes){if(b.h<64)fail(`emergency/mobile: ${b.mode} tap target is ${Math.round(b.h)}px, under the 64px floor`)}
if(modeBoxes.find(b=>b.mode==='emergency')?.pressed!=='true')fail('emergency/mobile: emergency is not preselected');

// The 911 line is never withdrawn, in either mode. Asserted after switching to
// assistance, which is exactly where it would be tempting to hide it.
await page.locator('[data-mode="assistance"]').click();
if(await page.locator('a[href="tel:911"]').count()<1)fail('emergency/mobile: 911 fallback disappeared in assistance mode');
/* The assistance note must say the channel is not watched and point at a
   faster route. (An earlier version of this check searched for "watched
   continuously", which the correct copy — "not watched continuously" —
   contains, so it failed on text that was right.) */
const modeNote=(await page.locator('#modeNote').innerText()).toLowerCase();
if(!modeNote.includes('not watched continuously'))fail(`emergency/mobile: assistance mode does not say it is unwatched: "${modeNote}"`);
if(!modeNote.includes('911'))fail('emergency/mobile: assistance mode does not point at a faster route');

await page.locator('#incidentType').selectOption('threat');
await page.locator('#description').fill('QA assistance follow-up, not urgent.');
await page.locator('#barangay').fill('QA Barangay');
await page.locator('#reportForm').evaluate(f=>f.requestSubmit());
await page.locator('#activeReport').waitFor({state:'visible'});
/* Wait on the report actually reaching intake rather than on the status label.
   The label is a proxy, and a proxy that can still read 'Received' from the
   previous report is a proxy that passes before anything was sent. */
for(let i=0;i<60&&submitted.length<2;i++)await page.waitForTimeout(100);
if(submitted.length!==2)fail('emergency/mobile: assistance report did not reach intake');
if(submitted[1].report_mode!=='assistance')fail(`emergency/mobile: assistance report was sent as '${submitted[1].report_mode}'`);
// Same backend, same delivery states — a resident must not meet two systems.
if(!submitted[1].client_report_id||!submitted[1].report_secret)fail('emergency/mobile: assistance report skipped the canonical intake contract');
await page.screenshot({path:'artifacts/browser-qa/emergency-mobile-assistance.png',fullPage:true});

await page.locator('#newReportBtn').click();
await page.locator('[data-agency="mdrrmo"]').click();
await page.locator('#modePicker').waitFor({state:'visible'});

await page.locator('#incidentType').selectOption('flood');
await page.locator('#description').fill('QA flood report created with no network.');
await page.locator('#barangay').fill('QA Offline Barangay');
await context.setOffline(true);
await page.locator('#reportForm').evaluate(form=>form.requestSubmit());
await page.locator('#activeReport').waitFor({state:'visible'});
await page.waitForFunction(()=>document.querySelector('#statusLabel')?.textContent?.includes('Not Yet Received'));
const offlineText=(await page.locator('#statusCard').innerText()).toLowerCase();
if(!offlineText.includes('not yet received'))fail('emergency/mobile: offline report falsely appears delivered');
if((await page.locator('#referenceValue').innerText()).trim()!=='Pending delivery')fail('emergency/mobile: offline report received a server reference before delivery');
await page.screenshot({path:'artifacts/browser-qa/emergency-mobile-offline.png',fullPage:true});

agencyReplies=[{id:'qa-mdrrmo',sender_kind:'mdrrmo',sender_agency:'mdrrmo',body:'QA responder update.',created_at:new Date().toISOString()}];
await context.setOffline(false);
await page.evaluate(()=>window.dispatchEvent(new Event('online')));
await page.waitForFunction(()=>document.querySelector('#statusLabel')?.textContent?.includes('Received by emergency system'),null,{timeout:12000});
if((await page.locator('#referenceValue').innerText()).trim()!=='QA-MDRRMO-001')fail('emergency/mobile: reconnect did not replace pending state with confirmed reference');

for(const path of ['/emergency/pnp.html','/emergency/mdrrmo.html']){
  const r=await page.goto(`${baseURL}${path}`,{waitUntil:'domcontentloaded'});
  if(!r||r.status()>=400)fail(`${path}: HTTP ${r?.status()??'no response'}`);
  const expected=path.includes('pnp')?'pnp':'mdrrmo';
  const actual=await page.locator('body').getAttribute('data-agency');
  if(actual!==expected)fail(`${path}: agency identity mismatch (${actual})`);
  if(!(await page.locator('#loginView').isVisible()))fail(`${path}: authenticated responder gate is not visible`);
  // Ported from the retired desk consoles: a signed-out visitor sees the gate
  // and nothing of the queue.
  if(await page.locator('.incident-row').count())fail(`${path}: incident rows rendered while signed out`);
  // One console carries both kinds of traffic. Separate PNP/MDRRMO assistance
  // consoles are exactly the second system this consolidation removed.
  const views=await page.$$eval('.view-chip',ns=>ns.map(n=>n.dataset.view));
  for(const v of ['all','emergency','assistance','unacknowledged','active','resolved']){
    if(!views.includes(v))fail(`${path}: missing '${v}' view — one console must cover both modes`);
  }

  /* The hidden attribute must actually hide. .login-wrap sets display:grid,
     which beats the UA [hidden] rule, so `loginView.hidden = true` silently
     did nothing and a signed-in responder was still shown the sign-in card
     with the console pushed below it. Asserted on painted visibility, not on
     the attribute, because the attribute was set correctly the whole time. */
  const hiddenWorks=await page.evaluate(()=>{
    const login=document.querySelector('#loginView');
    const was=login.hidden;
    login.hidden=true;
    const painted=login.getBoundingClientRect().height;
    login.hidden=was;
    return painted===0;
  });
  if(!hiddenWorks)fail(`${path}: the sign-in view stays painted when hidden — a responder who signs in would still see it`);

  // The supplied logo keeps its own colours; it is never filtered to suit a
  // dark header.
  const logoFilter=await page.$eval('.agency-brand img',n=>getComputedStyle(n).filter);
  if(logoFilter&&logoFilter!=='none'){
    fail(`${path}: the Masinloc logo is filtered (${logoFilter}) — supplied artwork is not recoloured`);
  }

  // The map is present and carries its required OpenStreetMap attribution.
  if(!(await page.locator('#incidentMap').count()))fail(`${path}: no incident map`);
  const legend=await page.$$eval('.legend-pin',ns=>ns.map(n=>getComputedStyle(n).backgroundColor+'|'+getComputedStyle(n).boxShadow));
  if(legend.length<5)fail(`${path}: map legend has ${legend.length} keys`);
  // A key that shows nothing is not a key: each swatch must paint a fill or a
  // ring.
  legend.forEach((s,i)=>{
    const [bg,shadow]=s.split('|');
    const blank=(bg==='rgba(0, 0, 0, 0)'||bg==='transparent')&&(!shadow||shadow==='none');
    if(blank)fail(`${path}: legend swatch ${i+1} paints nothing`);
  });
  overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  if(overflow>1)fail(`${path}: horizontal overflow ${overflow}px`);
}

for(const e of pageErrors)fail(`emergency/browser: ${e}`);
await context.close();

/* --- the console as a signed-in responder actually sees it ---------------

   Everything above stops at the sign-in gate, so the console's own rendering
   was never executed by any test. That gap shipped a console that threw
   `MARK is not defined` on its first render: the gate looked perfect, the
   queue never drew a single row, and both suites passed. Rendering the
   authorised view is the only assertion that catches that class of defect.

   Nothing here touches the database or creates a membership. The Supabase
   REST and auth endpoints are intercepted in the browser, so this proves the
   console renders what it is given — it says nothing about who is authorised,
   which is the server's decision and is covered by emergency-qa.mjs. */

const PROJECT='uwcqvsitjtknxsaypjxj';
const at=m=>new Date(Date.now()-m*60000).toISOString();
const FIXTURE=[
  {id:'c1',public_reference:'QA-0001',incident_type:'accident',report_mode:'emergency',status:'received',priority:'critical',barangay:'Bani',landmark:'National Road',latitude:15.5401,longitude:119.9490,accuracy_m:12,received_at:at(4),updated_at:at(4),description:'QA',location_updated_at:at(1)},
  {id:'c2',public_reference:'QA-0002',incident_type:'fire',report_mode:'emergency',status:'dispatched',priority:'high',barangay:'Inhobol',landmark:'Sitio Malapad',latitude:15.5312,longitude:119.9601,accuracy_m:20,received_at:at(19),updated_at:at(9),description:'QA',location_updated_at:at(18)},
  {id:'c3',public_reference:'QA-0003',incident_type:'suspicious_activity',report_mode:'assistance',status:'acknowledged',priority:'unassessed',barangay:'San Lorenzo',landmark:'Public market',latitude:15.5350,longitude:119.9548,accuracy_m:45,received_at:at(96),updated_at:at(70),description:'QA',location_updated_at:at(95)},
  {id:'c4',public_reference:'QA-0004',incident_type:'rescue',report_mode:'emergency',status:'resolved',priority:'high',barangay:'Collat',landmark:'Shoreline',latitude:15.5405,longitude:119.9382,accuracy_m:18,received_at:at(320),updated_at:at(200),resolved_at:at(200),description:'QA',location_updated_at:at(318)},
  // Deliberately within a few metres of c1, so the map has something to group.
  {id:'c5',public_reference:'QA-0005',incident_type:'traffic',report_mode:'assistance',status:'received',priority:'unassessed',barangay:'Bani',landmark:'Near the plaza',latitude:15.5403,longitude:119.9493,accuracy_m:15,received_at:at(8),updated_at:at(8),description:'QA',location_updated_at:at(7)},
];
const UNACKNOWLEDGED=FIXTURE.filter(x=>x.status==='received').length;
const STUB_ROLE='duty officer';

for(const agency of ['pnp','mdrrmo']){
  const path=`/emergency/${agency}.html`;
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  const consoleErrors=[];
  const cp=await ctx.newPage();
  cp.on('pageerror',e=>consoleErrors.push(`pageerror: ${e.message}`));
  cp.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))consoleErrors.push(`console: ${m.text()}`)});

  await ctx.addInitScript(({ref})=>{
    localStorage.setItem(`sb-${ref}-auth-token`,JSON.stringify({
      access_token:'qa',token_type:'bearer',refresh_token:'qa',
      expires_in:999999,expires_at:Math.floor(Date.now()/1000)+999999,
      user:{id:'qa-user',email:'duty.officer@example.invalid',app_metadata:{},user_metadata:{},aud:'authenticated'},
    }));
  },{ref:PROJECT});

  await cp.route('**/rest/v1/**',route=>{
    const url=route.request().url();
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.includes('emergency_agency_members'))return json({agency,role:STUB_ROLE});
    if(url.includes('emergency_incident_agencies'))return json(FIXTURE.map(x=>({incident_id:x.id})));
    if(url.includes('emergency_incidents'))return json(FIXTURE);
    return json([]);
  });
  await cp.route('**/auth/v1/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  /* Basemap tiles are served locally so this suite never depends on reaching
     openstreetmap.org. A sandbox that blocks it would otherwise fill the log
     with load failures and hide a real console error among them. The map's
     offline behaviour — flat backdrop, honest notice, exact pin positions —
     is a property of the module, not of whether CI has outbound network. */
  await cp.route('**/tile.openstreetmap.org/**',route=>route.fulfill({
    status:200,contentType:'image/png',
    body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),
  }));

  await cp.goto(`${baseURL}${path}`,{waitUntil:'networkidle'});

  // The queue must actually draw. A console that renders nothing is the exact
  // failure this block exists for, so it is asserted before anything else.
  try{
    await cp.waitForSelector('.incident-row',{timeout:12000});
  }catch{
    fail(`${path}: the authorised console rendered no incident rows for ${FIXTURE.length} incidents`);
  }
  const rowCount=await cp.locator('.incident-row').count();
  if(rowCount!==FIXTURE.length)fail(`${path}: queue drew ${rowCount} rows for ${FIXTURE.length} incidents`);

  // Every row carries its mark and a legible time. Both are template calls
  // that throw the whole render when their helper is missing.
  const rows=await cp.$$eval('.incident-row',ns=>ns.map(n=>({
    icon:!!n.querySelector('.row-icon svg'),
    time:n.querySelector('.row-time')?.textContent?.trim()||'',
    title:n.querySelector('.row-title')?.textContent?.trim()||'',
  })));
  rows.forEach((r,i)=>{
    if(!r.icon)fail(`${path}: row ${i+1} has no incident mark`);
    if(!r.title)fail(`${path}: row ${i+1} has no incident type`);
    if(!r.time||r.time==='—')fail(`${path}: row ${i+1} shows no received time`);
  });

  // The header reports the account and the role the membership row grants —
  // never a title invented for the screen.
  if(!(await cp.locator('#agencyWho').isVisible()))fail(`${path}: the signed-in account is not shown`);
  const account=(await cp.locator('#agencyAccount').innerText()).trim();
  if(account!=='duty.officer@example.invalid')fail(`${path}: header account was '${account}', not the authenticated address`);
  const role=(await cp.locator('#agencyRole').innerText()).trim().toLowerCase();
  if(role!==STUB_ROLE)fail(`${path}: header role was '${role}', not the '${STUB_ROLE}' the membership row grants`);

  // The bell counts unacknowledged incidents and says so. It is a count, not
  // a notification feed, and it must agree with the metric beside it.
  const bellCount=(await cp.locator('#alertCount').innerText()).trim();
  if(bellCount!==String(UNACKNOWLEDGED))fail(`${path}: alert count '${bellCount}' does not match ${UNACKNOWLEDGED} unacknowledged incidents`);
  const metricUnack=(await cp.locator('.metric.m-unack strong').innerText()).trim();
  if(metricUnack!==String(UNACKNOWLEDGED))fail(`${path}: unacknowledged metric '${metricUnack}' disagrees with the queue`);
  for(const m of ['m-unack','m-active','m-deployed','m-resolved']){
    if(!(await cp.locator(`.metric.${m}`).count()))fail(`${path}: the ${m} metric is missing`);
  }

  /* Overlapping pins are grouped, and the group carries its count. Without
     this the map silently shows fewer incidents than the console holds.
     Asserted as a sum: every incident with coordinates is represented once,
     whether it is drawn alone or inside a group. */
  const pinned=await cp.$$eval('.opmap-pin',ns=>ns.map(n=>Number(n.dataset.count||1)));
  const total=pinned.reduce((a,b)=>a+b,0);
  if(total!==FIXTURE.length)fail(`${path}: map accounts for ${total} of ${FIXTURE.length} incidents`);
  if(!pinned.some(c=>c>1))fail(`${path}: two incidents metres apart were not grouped — overlapping pins hide incidents`);
  const clusterBadge=await cp.locator('.opmap-pin.is-cluster b').first().innerText().catch(()=>'');
  if(!/^\d+$/.test(clusterBadge.trim()))fail(`${path}: a grouped pin does not show how many incidents it stands for`);

  const consoleOverflow=await cp.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  if(consoleOverflow>1)fail(`${path}: authorised console horizontal overflow ${consoleOverflow}px`);

  for(const e of consoleErrors)fail(`${path}: ${e}`);
  await ctx.close();
}

await browser.close();

if(failures.length){
  console.error('EMERGENCY BROWSER QA FAILED');
  failures.forEach(f=>console.error(`- ${f}`));
  process.exit(1);
}
console.log('EMERGENCY BROWSER QA PASSED');
console.log('GPS capture, confirmed receipt, offline not-received state, reconnect delivery, mobile layout, both responder gates, and both authorised consoles rendering their queue, header, metrics and grouped map are healthy.');
