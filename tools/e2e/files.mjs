// Real-app check for attachments, timed messages, deletes and on-disk traces. Starts and stops
// its own two instances (never other running Halka windows).
// usage: node tools/e2e/files.mjs <screenshot dir>   (after the fastrel build in tools/e2e/run.sh)
import { spawn } from "child_process";
import fs from "fs";
import { fileURLToPath } from "url";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = fileURLToPath(new URL("../../target/fastrel/halka.exe", import.meta.url));
const stamp = Date.now();
const procs = [];
const launch = (port, name) =>
  procs.push(spawn(exe, ["--profile", name], { env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: "ignore" }));

async function connect(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const p = l.find((x) => x.type === "page");
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const pend = new Map(); const errs = [];
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); else if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description); };
        const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(port + ": " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)); return r.result.result.value; };
        await send("Runtime.enable");
        return {
          ev, send, errs,
          invoke: (n, a = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(n)}, ${JSON.stringify(a)})`),
          async until(what, fn, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return; await sleep(250); } throw new Error(`${port}: timed out: ${what}`); },
          async clickText(t) { const ok = await ev(`(()=>{const e=[...document.querySelectorAll("button,a,[role=button]")].filter(e=>e.innerText.trim().includes(${JSON.stringify(t)})).sort((a,b)=>a.innerText.length-b.innerText.length)[0]; if(!e) return false; e.click(); return true})()`); if (!ok) throw new Error(`${port}: no "${t}"`); await sleep(400); },
          shot: async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(file, Buffer.from(r.result.data, "base64")); },
        };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("no page on " + port);
}

const step = async (name, f) => { process.stdout.write(name + " ... "); await f(); console.log("ok"); };
const out = process.argv[2];
let ok = false;
try {
  launch(9321, `e2e-fa-${stamp}`);
  launch(9322, `e2e-fb-${stamp}`);
  const A = await connect(9321), B = await connect(9322);
  await sleep(2500);
  let s, genel;
  await step("setup via commands", async () => {
    await A.invoke("set_name", { name: "Ayse" });
    await B.invoke("set_name", { name: "Berk" });
    const sid = await A.invoke("create_space", { name: "Dosya", relayRequired: false });
    const code = await A.invoke("create_invite", { space: sid, expiresInMs: 3600000, maxUses: null });
    await B.invoke("join_space", { code });
    await A.until("B member", async () => (await A.invoke("snapshot")).spaces[0].members.length === 2);
    s = (await A.invoke("snapshot")).spaces[0];
    genel = s.channels.find((c) => c.kind === "text").id;
    for (const n of [A, B]) {
      await n.until("space in sidebar", () => n.ev(`document.body.innerText.includes("Dosya")`));
      await n.clickText("Dosya");
      await n.until("composer", () => n.ev(`!!document.querySelector('textarea[aria-label="Mesaj"]')`));
    }
  });
  let m, f;
  await step("paste screenshot + file in the real composer", async () => {
    await A.ev(`(async()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const g=c.getContext('2d');g.fillStyle='#3a6';g.fillRect(0,0,640,360);
      const png=await new Promise(r=>c.toBlob(r,'image/png'));const dt=new DataTransfer();
      dt.items.add(new File([png],'shot.png',{type:'image/png'}));dt.items.add(new File(['IZDOSYA-'.repeat(20000)],'not.txt',{type:'text/plain'}));
      const ta=document.querySelector('textarea[aria-label="Mesaj"]');ta.focus();ta.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));return 1})()`);
    await A.until("uploads done", () => A.ev(`(()=>{const t=[...document.querySelectorAll('.num')].map(e=>e.textContent);return t.filter(x=>/ (B|KB|MB)$/.test(x)).length>=2&&!t.some(x=>/%$/.test(x))})()`), 15000).catch(async (e) => {
      console.log("\n  chips:", await A.ev(`[...document.querySelectorAll('.group\\\\/att')].map(e=>e.innerText.replace(/\\n/g,' | '))`));
      console.log("  toasts:", await A.ev(`document.body.innerText.slice(-400)`));
      throw e;
    });
    await A.ev(`document.querySelector('textarea[aria-label="Mesaj"]').focus()`);
    await A.send("Input.insertText", { text: "IZMETIN ekli mesaj" });
    await A.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await A.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await B.until("B shows the image inline from a blob URL", () => B.ev(`!!document.querySelector('img[alt="shot.webp"][src^="blob:"]')`), 45000);
    await B.shot(out + "/b_attachments.png");
    m = (await B.invoke("messages", { space: s.id, channel: genel, before: null, limit: 20 })).find((x) => x.files.length === 2);
    f = m.files.find((x) => x.name === "not.txt");
  });
  await step("download, save with Mark of the Web", async () => {
    await B.invoke("fetch_file", { space: s.id, msg: m.id, hash: f.hash });
    await B.until("file downloaded", () => B.invoke("file_ready", { hash: f.hash }));
    const path = await B.invoke("save_file", { space: s.id, msg: m.id, hash: f.hash });
    try {
      if (fs.readFileSync(path, "utf8") !== "IZDOSYA-".repeat(20000)) throw new Error("saved file differs");
      const zone = fs.readFileSync(path + ":Zone.Identifier", "utf8");
      if (!/ZoneId=3/.test(zone)) throw new Error("no Mark of the Web");
      console.log(`\n  saved ${path} with ${zone.trim().replace(/\r?\n/g, " ")}`);
    } finally {
      fs.rmSync(path, { force: true });
    }
  });
  await step("delete purges the file on the peer", async () => {
    await A.invoke("delete_message", { space: s.id, message: m.id });
    await B.until("gone on B", async () => !(await B.invoke("file_ready", { hash: f.hash })));
  });
  await step("timed message vanishes on both", async () => {
    const t = await A.invoke("send_message", { space: s.id, channel: genel, text: "IZSURELI kaybolacak", replyTo: null, ttlMs: 6000 });
    await B.until("arrives", async () => (await B.invoke("messages", { space: s.id, channel: genel, before: null, limit: 20 })).some((x) => x.id === t));
    await B.until("gone on both", async () => {
      const gone = async (n) => !(await n.invoke("messages", { space: s.id, channel: genel, before: null, limit: 20 })).some((x) => x.id === t);
      return (await gone(A)) && (await gone(B));
    });
    await A.shot(out + "/a_after.png");
  });
  console.log("A errors:", A.errs.slice(0, 5), "B errors:", B.errs.slice(0, 5));
  ok = true;
} finally {
  for (const p of procs) p.kill();
  await sleep(2500);
}
// with both apps closed, nothing readable may remain in either profile (WebView2 data included)
const root = `${process.env.APPDATA}/app.halka.desktop/profiles`;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const hits = []; let files = 0, locked = 0;
for (const p of ["fa", "fb"]) {
  const dir = `${root}/e2e-${p}-${stamp}`;
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    let buf; try { buf = fs.readFileSync(file); files++; } catch { locked++; continue; }
    for (const mk of ["IZMETIN", "IZDOSYA", "IZSURELI"])
      if (buf.includes(Buffer.from(mk, "utf8")) || buf.includes(Buffer.from(mk, "utf16le"))) hits.push(`${mk} in ${file.slice(root.length)}`);
  }
}
console.log(`trace scan: ${files} files, ${locked} unreadable, ${hits.length} hit(s)`);
for (const h of hits) console.log("  " + h);
console.log(`profiles: ${root}/e2e-f{a,b}-${stamp}`);
process.exit(ok && hits.length === 0 ? 0 : 1);
