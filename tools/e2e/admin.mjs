// Admin UI paths with real mouse input on two instances (CDP 9301 = owner, 9302 = member):
// invite dialog, role create + assign via context menu, private channel, edit/delete, settings, kick.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const p = l.find((x) => x.type === "page");
      if (p) {
        const ws = new WebSocket(p.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        let id = 0;
        const pend = new Map();
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id) pend.get(d.id)?.(d);
        };
        const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
        const ev = async (e) => {
          const r = await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true });
          if (r.result.exceptionDetails) throw new Error(port + " " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
          return r.result.result.value;
        };
        const inv = (n, a = {}) => ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(n)},${JSON.stringify(a)})`);
        const at = async (find) => {
          for (let i = 0; i < 40; i++) {
            const xy = await ev(`(()=>{const e=(${find}); if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`);
            if (xy) return xy;
            await sleep(150);
          }
          throw new Error(`${port}: element not found: ${find}`);
        };
        const mouse = async ([x, y], button = "left") => {
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
          await sleep(250);
        };
        const click = async (find, button) => mouse(await at(find), button);
        const hover = async (find) => { const [x, y] = await at(find); await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await sleep(300); };
        const typeText = async (t) => send("Input.insertText", { text: t });
        const key = async (k, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code, text: k === "Enter" ? "\r" : undefined }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); await sleep(200); };
        const until = async (what, fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(250); } throw new Error(`${port}: timed out: ${what}`); };
        await sleep(1200);
        return { ev, inv, click, hover, typeText, key, until, send };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("no page " + port);
}

const btn = (label) => `[...document.querySelectorAll("button,[role=menuitem],[role=menuitemcheckbox],[role=tab]")].filter(b=>b.offsetParent!==null||b.getClientRects().length).find(b=>(b.getAttribute("aria-label")||"")===${JSON.stringify(label)}||b.innerText.trim()===${JSON.stringify(label)}||b.innerText.trim().startsWith(${JSON.stringify(label)}))`;
const A = await connect(9301), B = await connect(9302);
const step = async (name, f) => { process.stdout.write(name + " ... "); await f(); console.log("ok"); };

let sid, bid, genel;
await step("setup (core)", async () => {
  await A.inv("set_name", { name: "Ayşe" });
  await B.inv("set_name", { name: "Berk" });
  sid = await A.inv("create_space", { name: "Yönetim" });
  await B.inv("join_space", { code: await A.inv("create_invite", { space: sid, expiresInMs: null, maxUses: null }) });
  bid = (await B.inv("snapshot")).me.id;
  genel = (await A.inv("snapshot")).spaces[0].channels.find((c) => c.kind === "text").id;
  await A.until("B listed as online", async () => (await A.inv("snapshot")).spaces[0].members.some((m) => m.id === bid && m.online));
});

await step("invite dialog yields a working halka1 code", async () => {
  await A.click(btn("Davet et"));
  await A.click(btn("Davet kodu oluştur"));
  await A.until("code shown", async () => (await A.ev(`document.querySelector("[role=dialog] code")?.innerText ?? ""`)).startsWith("halka1"));
  const code = await A.ev(`document.querySelector("[role=dialog] code").innerText`);
  if ((await A.inv("join_space", { code })) !== sid) throw new Error("code does not decode to this space");
  await A.key("Escape", 27);
});

let role;
await step("create role in settings", async () => {
  await A.click(btn("Halka ayarları"));
  await A.click(btn("Roller"));
  const before = (await A.inv("snapshot")).spaces[0].roles.length;
  await A.click(`[...document.querySelectorAll("[role=dialog] button")].find(b=>b.innerText.trim()==="Rol")`);
  await A.until("role created", async () => (await A.inv("snapshot")).spaces[0].roles.length === before + 1);
  role = (await A.inv("snapshot")).spaces[0].roles.find((r) => r.name === "Yeni rol").id;
  await A.key("Escape", 27);
});

await step("assign role via member context menu", async () => {
  await A.click(`[...document.querySelectorAll("[aria-label=Üyeler] *")].find(e=>e.children.length===0&&e.innerText?.trim()==="Berk")`, "right");
  await A.hover(btn("Roller"));
  await A.click(btn("Yeni rol"));
  await B.until("B sees own role", async () => (await B.inv("snapshot")).spaces[0].members.find((m) => m.id === bid).roles.includes(role));
  await A.key("Escape", 27);
});

await step("private channel hides it from non-holders", async () => {
  await A.click(btn("Halka ayarları"));
  await A.click(btn("Kanallar"));
  await A.click(`[...document.querySelectorAll("[role=dialog] button")].find(b=>b.innerText.trim().startsWith("genel"))`);
  await A.click(`document.querySelector("[role=dialog] [aria-label='Özel kanal']")`);
  await A.click(btn("Kaydet"));
  await B.until("genel hidden from B", async () => !(await B.inv("snapshot")).spaces[0].channels.some((c) => c.id === genel));
  // now allow B's role back in
  await A.click(`[...document.querySelectorAll("[role=dialog] button")].find(b=>b.innerText.trim().startsWith("genel"))`);
  await A.click(`[...document.querySelectorAll("[role=dialog] button[aria-pressed]")].find(b=>b.innerText.includes("Yeni rol"))`);
  await A.click(btn("Kaydet"));
  await B.until("genel visible via role", async () => (await B.inv("snapshot")).spaces[0].channels.some((c) => c.id === genel));
  await A.key("Escape", 27);
});

await step("edit and delete own message via hover tools", async () => {
  await A.click(`document.querySelector("textarea")`);
  await A.typeText("yanlis yazdim");
  await A.key("Enter", 13);
  await B.until("B got it", async () => (await B.inv("messages", { space: sid, channel: genel, before: null, limit: 20 })).some((m) => m.text === "yanlis yazdim"));
  const row = `[...document.querySelectorAll(".group")].find(e=>e.innerText.includes("yanlis yazdim"))`;
  await A.hover(row);
  await A.click(btn("Düzenle"));
  await A.ev(`(()=>{const t=[...document.querySelectorAll("textarea")].find(t=>t.value==="yanlis yazdim"); t.focus(); t.select(); return 1})()`);
  await A.typeText("dogru yazdim");
  await A.key("Enter", 13);
  await B.until("edit reached B", async () => (await B.inv("messages", { space: sid, channel: genel, before: null, limit: 20 })).some((m) => m.text === "dogru yazdim" && m.edited));
  const row2 = `[...document.querySelectorAll(".group")].find(e=>e.innerText.includes("dogru yazdim"))`;
  await A.hover(row2);
  await A.click(btn("Sil"));
  await A.click(btn("Silinsin mi?"));
  await B.until("delete reached B", async () => (await B.inv("messages", { space: sid, channel: genel, before: null, limit: 20 })).some((m) => m.deleted));
});

await step("app settings save", async () => {
  const before = (await A.inv("get_settings")).noise_suppression;
  await A.click(btn("Ayarlar"));
  await A.click(btn("Ses"));
  await A.click(`[...document.querySelectorAll("[role=dialog] [role=switch]")].find(s=>/gürültü/i.test(s.getAttribute("aria-label")||s.closest("div")?.parentElement?.innerText||""))`);
  await A.until("setting persisted", async () => (await A.inv("get_settings")).noise_suppression !== before);
  await A.key("Escape", 27);
});

await step("kick via context menu", async () => {
  await A.click(`[...document.querySelectorAll("[aria-label=Üyeler] *")].find(e=>e.children.length===0&&e.innerText?.trim()==="Berk")`, "right");
  await A.hover(btn("Halkadan at"));
  await A.click(btn("Evet, Berk çıkarılsın"));
  await B.until("B removed", async () => (await B.inv("snapshot")).spaces.length === 0);
  if (await B.ev(`!document.body.innerText.includes("çıkarıldın")`)) console.log("(no removal toast seen)");
});
console.log("ALL OK");
process.exit(0);
