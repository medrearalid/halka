import { expect, test } from "bun:test";
import { cmpVersion, parseChangelog, unseenReleases } from "../src/lib/changelog";
import md from "../../CHANGELOG.md" with { type: "text" };

const sample = `# Notlar\n\nGiriş metni\n- giriş maddesi değil\n\n## 0.2.0\n\n- yeni\n- daha yeni\n\n## 0.1.5\n- orta\n\n## v0.1.4\r\n- eski\r\n`;

test("parses sections and items, ignores the preamble", () => {
  expect(parseChangelog(sample)).toEqual([
    { version: "0.2.0", items: ["yeni", "daha yeni"] },
    { version: "0.1.5", items: ["orta"] },
    { version: "0.1.4", items: ["eski"] },
  ]);
});

test("version compare is numeric", () => {
  expect(cmpVersion("0.1.10", "0.1.9")).toBeGreaterThan(0);
  expect(cmpVersion("0.2.0-test", "0.2.0")).toBe(0);
  expect(cmpVersion("1.0.0", "0.9.9")).toBeGreaterThan(0);
});

test("shows every skipped release up to the running one, nothing past it", () => {
  expect(unseenReleases(sample, "0.1.4", "0.2.0").map((r) => r.version)).toEqual(["0.2.0", "0.1.5"]);
  expect(unseenReleases(sample, "0.1.4", "0.1.5").map((r) => r.version)).toEqual(["0.1.5"]);
  expect(unseenReleases(sample, "0.2.0", "0.2.0")).toEqual([]);
  expect(unseenReleases(sample, null, "0.1.5").map((r) => r.version)).toEqual(["0.1.5"]);
});

test("the real CHANGELOG has a section for the app version", async () => {
  const conf = await Bun.file(new URL("../src-tauri/tauri.conf.json", import.meta.url)).json();
  expect(parseChangelog(md).some((r) => r.version === conf.version && r.items.length > 0)).toBe(true);
});
