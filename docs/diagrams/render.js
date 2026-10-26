const {chromium}=require('playwright');const fs=require('fs');
(async()=>{const b=await chromium.launch();
for (const n of process.argv.slice(2)){const svg=fs.readFileSync(`t/${n}.svg`,'utf8');const w=+svg.match(/width="(\d+)"/)[1],h=+svg.match(/height="(\d+)"/)[1];
const p=await b.newPage({viewport:{width:w,height:h},deviceScaleFactor:2});await p.setContent(`<html><body style="margin:0">${svg}</body></html>`);await p.waitForTimeout(300);await p.screenshot({path:`t/${n}.png`});await p.close();}
await b.close()})()
