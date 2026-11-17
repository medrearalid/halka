// Drives two real Halka instances (CDP ports 9301/9302) through the core flows.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function connect(port) {
  for (let i = 0; i < 60; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const p = l.find(x => x.type === "page"); if (p) { const ws = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return mk(ws, port); } } catch {} await sleep(500); }
  throw new Error("no page on " + port);
}
function mk(ws, port) {
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) pend.get(d.id)?.(d); else if (d.method === "Runtime.exceptionThrown") errs.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errs.push(d.params.args.map(a => a.value ?? a.description).join(" ")); };
  const send = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(port + ": " + JSON.stringify(r.result.exceptionDetails.exception?.description)); return r.result.result.value; };
  return { send, ev, errs, port,
    text: () => ev("document.body.innerText"),
    async type(sel, t) { for (let i = 0; i < 80 && !(await ev(`!!document.querySelector(${JSON.stringify(sel)})`)); i++) await sleep(250); await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`); await send("Input.insertText", { text: t }); },
    async key(k) { const code = { Enter: 13 }[k]; await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, text: k === "Enter" ? "\r" : undefined }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); },
    async clickText(t, tag = "button,[role=menuitem],[role=option],a,[data-slot]") { const ok = await ev(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(tag)})].filter(e=>e.innerText.trim().includes(${JSON.stringify(t)})); const e=els.sort((a,b)=>a.innerText.length-b.innerText.length)[0]; if(!e) return false; e.click(); return true})()`); if (!ok) throw new Error(`${port}: no clickable "${t}"`); await sleep(300); },
    invoke: (n, a = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(n)}, ${JSON.stringify(a)})`),
    async until(what, fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(250); } throw new Error(`${port}: timed out: ${what}`); },
    shot: async (file) => { const r = await send("Page.captureScreenshot", { format: "png" }); (await import("fs")).writeFileSync(file, Buffer.from(r.result.data, "base64")); },
  };
}
const out = process.argv[2];
const A = await connect(9301), B = await connect(9302);
for (const x of [A, B]) await x.send("Runtime.enable");
const step = async (name, f) => { process.stdout.write(name + " ... "); await f(); console.log("ok"); };
await step("names", async () => {
  await A.type("#ob-name", "Ayşe"); await A.key("Enter");
  await B.type("#ob-name", "Berk"); await B.key("Enter");
  await A.until("A named", async () => (await A.text()).includes("Merhaba Ayşe"));
  await B.until("B named", async () => (await B.text()).includes("Merhaba Berk"));
});
await step("create space via UI", async () => {
  await A.clickText("Yeni halka oluştur");
  await A.ev(`document.querySelector("form input").focus()`); await A.send("Input.insertText", { text: "Kanka" }); await A.key("Enter");
  await A.until("space shell", async () => (await A.text()).includes("genel"));
  await A.shot(out + "/a_space.png");
});
let code;
await step("invite", async () => {
  const s = (await A.invoke("snapshot")).spaces[0];
  code = await A.invoke("create_invite", { space: s.id, expiresInMs: 86400000, maxUses: null });
});
await step("join via UI", async () => {
  await B.clickText("Davet koduyla katıl");
  await B.ev(`document.querySelector("form input, form textarea").focus()`); await B.send("Input.insertText", { text: code }); await B.key("Enter");
  await B.until("joined", async () => (await B.text()).includes("Kanka"), 45000);
});
await step("chat both ways", async () => {
  await A.until("composer", async () => A.ev(`!!document.querySelector("textarea")`));
  await A.type("textarea", "selam Berk, ses geliyor mu?"); await A.key("Enter");
  await B.until("B sees", async () => (await B.text()).includes("selam Berk"));
  await B.until("B composer", async () => B.ev(`!!document.querySelector("textarea")`));
  await B.type("textarea", "<img src=x onerror=alert(1)> geliyor"); await B.key("Enter");
  await A.until("A sees raw text", async () => (await A.text()).includes("<img src=x onerror=alert(1)> geliyor"));
  if (await A.ev(`!!document.querySelector("img[src=x]")`)) throw new Error("XSS: html rendered");
  await A.shot(out + "/a_chat.png");
});
await step("voice room", async () => {
  const s = (await A.invoke("snapshot")).spaces[0]; const vc = s.channels.find(c => c.kind === "voice");
  await A.invoke("voice_join", { space: s.id, channel: vc.id });
  await B.invoke("voice_join", { space: s.id, channel: vc.id });
  await A.until("2 in room", async () => (await A.invoke("snapshot")).spaces[0].channels.find(c => c.id === vc.id).voice.length === 2);
  await A.clickText("Sohbet").catch(() => {});
  await sleep(1500);
  await A.shot(out + "/a_voice.png");
});
console.log("A errors:", A.errs.slice(0, 5)); console.log("B errors:", B.errs.slice(0, 5));
process.exit(0);
