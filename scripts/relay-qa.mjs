import fs from 'node:fs';

const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const relay=read('emergency/relay.js');
const emergency=read('emergency/emergency.js');
const index=read('emergency/index.html');
const sw=read('emergency/sw.js');

const failures=[];
const expect=(ok,msg)=>{if(!ok)failures.push(msg)};

expect(relay.includes("const PROTOCOL_VERSION='masinloc-relay/1'"),'relay protocol version missing');
expect(relay.includes('native-relay-unavailable'),'relay must fail explicitly when no native bridge exists');
expect(!/sync_state\s*=\s*['\"]delivered['\"]/.test(relay),'relay bridge must never mark reports delivered');
expect(!/status\s*=\s*['\"]received['\"]/.test(relay),'relay bridge must never mark reports received');
expect(!/\bfetch\s*\(/.test(relay),'relay bridge must not bypass the existing backend delivery path');
expect(index.indexOf('relay.js')<index.indexOf('emergency.js'),'relay bridge must load before emergency.js');
expect(sw.includes('relay.js?v=${SHELL_VERSION}'),'service worker shell must cache relay.js');
expect(emergency.includes('MasinlocRelay'),'emergency flow must integrate the relay bridge');

if(failures.length){
  console.error('Relay QA failed:');
  failures.forEach(x=>console.error(' - '+x));
  process.exit(1);
}
console.log('Relay QA passed.');
