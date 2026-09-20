(()=>{
'use strict';

/*
 * Masinloc Emergency Relay Bridge v1
 *
 * Relay acceptance is NEVER server receipt. This module only hands a queued
 * report to a trusted native shell. It never changes sync_state, incident
 * status, public reference, or responder-facing state.
 */
const PROTOCOL_VERSION='masinloc-relay/1';
const DEFAULT_TTL_MS=24*60*60*1000;
const DEFAULT_HOP_LIMIT=8;

function nowIso(){return new Date().toISOString()}
function uuid(){
  if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();
  const b=new Uint8Array(16);globalThis.crypto?.getRandomValues?.(b);
  b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function getBridge(){
  const test=globalThis.__MASINLOC_RELAY_TEST_BRIDGE__;
  if(test&&typeof test.enqueuePacket==='function')return{kind:'test',send:p=>test.enqueuePacket(p),delivered:id=>test.markDelivered?.(id)};

  const android=globalThis.MasinlocRelayNative;
  if(android&&typeof android.enqueuePacket==='function')return{
    kind:'android',
    send:p=>android.enqueuePacket(JSON.stringify(p)),
    delivered:id=>android.markDelivered?.(id)
  };

  const ios=globalThis.webkit?.messageHandlers?.masinlocRelay;
  if(ios&&typeof ios.postMessage==='function')return{
    kind:'ios',
    send:p=>ios.postMessage({action:'enqueue',packet:p}),
    delivered:id=>ios.postMessage({action:'delivered',client_report_id:id})
  };
  return null;
}

function capability(){
  const bridge=getBridge();
  return{
    available:Boolean(bridge),
    transport:bridge?.kind||null,
    protocol:PROTOCOL_VERSION,
    meaning:'Relay availability does not mean PNP/MDRRMO received the report.'
  };
}

function reportPayload(report){
  if(!report||typeof report!=='object')throw new TypeError('report required');
  if(!report.client_report_id)throw new Error('client_report_id required');
  if(!report.report_secret)throw new Error('report_secret required');
  if(!report.target_agency)throw new Error('target_agency required');

  /*
   * Sensitive plaintext exists here only inside the originating app process.
   * A conforming native host MUST encrypt it before persistent relay storage
   * or peer transmission. See docs/RELAY_PROTOCOL_V1.md.
   */
  return{
    client_report_id:report.client_report_id,
    report_secret:report.report_secret,
    target_agency:report.target_agency,
    report_mode:report.report_mode,
    incident_type:report.incident_type,
    description:report.description,
    reporter_name:report.reporter_name??null,
    reporter_contact:report.reporter_contact??null,
    contact_preference:report.contact_preference??'chat',
    latitude:report.latitude??null,
    longitude:report.longitude??null,
    accuracy_m:report.accuracy_m??null,
    location_captured_at:report.location_captured_at??null,
    barangay:report.barangay??null,
    landmark:report.landmark??null,
    source_created_at:report.source_created_at
  };
}

function makeEnvelope(report){
  const created=Date.now();
  return{
    protocol_version:PROTOCOL_VERSION,
    packet_id:uuid(),
    kind:'emergency_report',
    created_at:new Date(created).toISOString(),
    expires_at:new Date(created+DEFAULT_TTL_MS).toISOString(),
    hop_limit:DEFAULT_HOP_LIMIT,
    client_report_id:report.client_report_id,
    destination:{service:'masinloc-emergency-response',agency:report.target_agency},
    payload:reportPayload(report)
  };
}

async function offerReport(report){
  if(report?.sync_state==='delivered')return{accepted:false,reason:'already-delivered',transport:null};
  const bridge=getBridge();
  if(!bridge)return{accepted:false,reason:'native-relay-unavailable',transport:null};
  const packet=makeEnvelope(report);
  try{
    const result=await bridge.send(packet);
    if(result===false)return{accepted:false,reason:'native-relay-rejected',transport:bridge.kind};
    return{accepted:true,packet_id:packet.packet_id,transport:bridge.kind,queued_at:nowIso()};
  }catch(error){
    return{accepted:false,reason:'native-relay-error',transport:bridge.kind,error:String(error?.message||error)};
  }
}

async function markDelivered(clientReportId){
  if(!clientReportId)return;
  const bridge=getBridge();
  if(!bridge)return;
  try{await bridge.delivered?.(clientReportId)}catch{}
}

const api=Object.freeze({protocol:PROTOCOL_VERSION,capability,offerReport,markDelivered});
Object.defineProperty(globalThis,'MasinlocRelay',{value:api,writable:false,configurable:false});
globalThis.dispatchEvent?.(new CustomEvent('masinloc:relay-ready',{detail:capability()}));
})();