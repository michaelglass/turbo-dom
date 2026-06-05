import { createRequire } from 'node:module';
import { createEnvironment } from '../src/runtime/index.mjs';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const rows = Array.from({length:80},(_,i)=>`<div class="row r${i}"><label for="i${i}">L${i}</label><input id="i${i}" class="field" data-k="${i}"><button class="btn">B${i}</button><span>txt ${i}</span></div>`).join('');
const html = `<!doctype html><body><main id="app"><form>${rows}</form></main></body>`;
function work(doc){
  let n=0;
  n += doc.querySelectorAll('input.field').length;
  n += doc.querySelectorAll('.row .btn').length;
  n += doc.querySelectorAll('[data-k]').length;
  n += doc.getElementById('i40') ? 1 : 0;
  n += doc.getElementsByTagName('input').length;
  for(const b of doc.querySelectorAll('button')) n += b.textContent.length;
  return n;
}
function bench(doc, ms=1200){
  for(let i=0;i<20;i++) work(doc);
  let it=0; const s=process.hrtime.bigint(); const dl=s+BigInt(ms)*1000000n;
  while(process.hrtime.bigint()<dl){ work(doc); it++; }
  return it/(Number(process.hrtime.bigint()-s)/1e6)*1000;
}
const td = bench(createEnvironment(html).document);
const jd = bench(new JSDOM(html).window.document);
console.log('query iters/sec — turbo-dom:', Math.round(td).toLocaleString(), '| jsdom:', Math.round(jd).toLocaleString(), '| ratio:', (td/jd).toFixed(2)+'x');
