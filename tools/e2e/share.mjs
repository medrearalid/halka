const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function connect(port) {
  for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find(x => x.type === "page"); if (p) { const ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r); let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); }; const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }); const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(port + " " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)); return r.result.result.value; }; const inv = (n, a = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(n)},${JSON.stringify(a)})`); await sleep(1500); return { send, ev, inv, port }; } } catch {} await sleep(500); }
  throw new Error("no page " + port);
}
const out = process.argv[2];
const A = await connect(9301), B = await connect(9302);
await A.inv("set_name", { name: "Ayşe" }); await B.inv("set_name", { name: "Berk" });
const sid = await A.inv("create_space", { name: "Yayın" });
const code = await A.inv("create_invite", { space: sid, expiresInMs: null, maxUses: null });
await B.inv("join_space", { code });
const vc = (await A.inv("snapshot")).spaces[0].channels.find(c => c.kind === "voice").id;
await A.inv("voice_join", { space: sid, channel: vc }); await B.inv("voice_join", { space: sid, channel: vc });
await sleep(1500);
console.log("in room");
for (const X of [A, B]) await X.ev(`(()=>{const e=[...document.querySelectorAll("button")].find(e=>e.innerText.trim().startsWith("Sohbet")); e?.click(); return !!e})()`);
await sleep(800);
// A clicks the real share button
await A.ev(`(()=>{window.__gap=0; let last=performance.now(); const tick=(t)=>{window.__gap=Math.max(window.__gap,t-last); last=t; requestAnimationFrame(tick)}; requestAnimationFrame(tick); return 1})()`);
await sleep(500); await A.ev("window.__gap=0");
const clicked = await A.ev(`(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.getAttribute("aria-label")||b.innerText).includes("Ekranı paylaş")); if(!b) return false; b.click(); return true})()`);
await sleep(600);
const sheet = await A.ev(`document.querySelector("[role=dialog]")?.innerText.slice(0,40) ?? "no sheet"`);
console.log("share sheet:", JSON.stringify(sheet));
await A.ev(`(()=>{[...document.querySelectorAll("[role=dialog] [role=radio]")].find(b=>b.innerText.includes("Dengeli"))?.click(); [...document.querySelectorAll("[role=dialog] button")].find(b=>b.innerText.includes("Paylaşmaya başla")).click(); return 1})()`);
console.log("share clicked", clicked);
for (let i = 0; i < 40; i++) { const s = await B.inv("snapshot"); if (s.spaces[0].channels.find(c => c.id === vc).streams.length) { console.log("B sees stream after", i * 250, "ms"); break; } await sleep(250); }
await sleep(1000);
// B opens the stream tile (any element mentioning the sharer's stream)
const tile = await B.ev(`(()=>{const c=[...document.querySelectorAll("button,[role=button]")].find(e=>/Ayşe/.test(e.innerText)&&/(yayın|ekran|izle)/i.test(e.innerText+e.getAttribute("aria-label"))); if(c){c.click(); return c.innerText.slice(0,60)} return document.querySelectorAll("canvas").length+" canvases"})()`);
console.log("tile:", tile);
await sleep(4000);
const px = await B.ev(`(()=>{const c=[...document.querySelectorAll("canvas")].sort((a,b)=>b.width*b.height-a.width*a.height)[0]; if(!c) return "no canvas"; const x=document.createElement("canvas"); x.width=64;x.height=36; const g=x.getContext("2d"); g.drawImage(c,0,0,64,36); const d=g.getImageData(0,0,64,36).data; let lit=0; for(let i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]>40) lit++; return c.width+"x"+c.height+" lit="+lit+"/2304"})()`);
console.log("B canvas:", px);
console.log("A longest UI frame gap during share start:", Math.round(await A.ev("window.__gap")), "ms");
const r = await B.send("Page.captureScreenshot", { format: "png" }); (await import("fs")).writeFileSync(out + "/b_watch.png", Buffer.from(r.result.data, "base64"));
const r2 = await A.send("Page.captureScreenshot", { format: "png" }); (await import("fs")).writeFileSync(out + "/a_share.png", Buffer.from(r2.result.data, "base64"));
process.exit(0);
