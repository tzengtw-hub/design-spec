#!/usr/bin/env node
// Gherkin 驗收執行器：讀 docs/features/ 的情境，用無頭瀏覽器打開 index.html 逐步操作，
// 結果寫到 docs/features/results/latest.md（給人看）和 latest.json（給 hook 看）。
//
//   node tests/gherkin/run.cjs            全部跑
//   node tests/gherkin/run.cjs --dry      不開瀏覽器，只檢查每個步驟有沒有對應的步驟定義
//   node tests/gherkin/run.cjs 001-x.feature   只跑指定檔案（不寫 latest，只印結果）
//
// 收得下的格式：.feature 檔；或 .md 檔裡的 ```gherkin 區塊（外部工具常輸出這種）。
// 關鍵字：英文、繁中、簡中都可以；冒號全形半形都可以。
// 步驟定義放在 tests/steps/*.cjs，由子代理 tester 補。
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const FEATURE_DIR = path.join(ROOT, "docs", "features");
const RESULT_DIR = path.join(FEATURE_DIR, "results");
const STEP_DIR = path.join(ROOT, "tests", "steps");
const SITE = path.join(ROOT, "index.html");

// ---------- 關鍵字 ----------
const KW = {
  feature: ["Feature", "Business Need", "Ability", "功能", "功能特性", "特性"],
  rule: ["Rule", "規則", "规则"],
  background: ["Background", "背景"],
  outline: ["Scenario Outline", "Scenario Template", "場景大綱", "劇本大綱", "场景大纲", "剧本大纲", "情境大綱", "情境大纲"],
  scenario: ["Scenario", "Example", "場景", "劇本", "场景", "剧本", "情境", "範例", "范例"],
  examples: ["Examples", "Scenarios", "例子", "示例", "範例資料", "範例表", "例子表"],
};
const STEP_KW = {
  Given: ["Given ", "假如", "假設", "假定", "假设", "前提", "給定", "给定"],
  When: ["When ", "當", "当"],
  Then: ["Then ", "那麼", "那么", "則", "则"],
  And: ["And ", "而且", "並且", "同時", "并且", "同时", "且", "與", "与"],
  But: ["But ", "但是", "但"],
  Star: ["* "],
};
const STEP_LIST = Object.entries(STEP_KW)
  .flatMap(([type, words]) => words.map((w) => ({ type, w })))
  .sort((a, b) => b.w.length - a.w.length);

function headerOf(line) {
  // 回傳 { kind, name }；例如 "場景大綱：比價" → { kind: "outline", name: "比價" }
  const order = ["outline", "feature", "rule", "background", "examples", "scenario"];
  for (const kind of order) {
    for (const w of KW[kind].slice().sort((a, b) => b.length - a.length)) {
      const m = line.match(new RegExp("^" + w.replace(/ /g, "\\s+") + "\\s*[:：]\\s*(.*)$", "i"));
      if (m) return { kind, name: m[1].trim() };
    }
  }
  return null;
}
function stepOf(line) {
  for (const { type, w } of STEP_LIST) {
    if (line.startsWith(w) || (w.endsWith(" ") && line.toLowerCase().startsWith(w.toLowerCase())))
      return { keyword: w.trim(), type, text: line.slice(w.length).trim().replace(/^[，,：:]\s*/, "") };
  }
  return null;
}
const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim().replace(/\\\|/g, "|"));

// ---------- 解析 ----------
function parse(text, file) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const feature = { file, name: "", tags: [], background: [], scenarios: [] };
  let tags = [], ruleBg = null, inRule = false, cur = null, mode = null, lastStep = null, examples = null;
  let doc = null;
  const err = (i, msg) => { throw new Error(`${path.basename(file)} 第 ${i + 1} 行：${msg}`); };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (doc) {
      if (line === doc.fence) { lastStep.docString = doc.lines.join("\n"); doc = null; }
      else doc.lines.push(raw.slice(Math.min(doc.indent, raw.length - raw.trimStart().length)));
      return;
    }
    if (!line || line.startsWith("#")) return;
    if (line.startsWith('"""') || line.startsWith("```")) {
      if (!lastStep) err(i, "多行文字前面要有步驟");
      doc = { fence: line.slice(0, 3), lines: [], indent: raw.length - raw.trimStart().length };
      return;
    }
    if (line.startsWith("@")) { tags.push(...line.split(/\s+/).filter((t) => t.startsWith("@"))); return; }
    if (line.startsWith("|")) {
      if (mode === "examples") { if (!examples.header) examples.header = cells(line); else examples.rows.push(cells(line)); }
      else if (lastStep) (lastStep.table = lastStep.table || []).push(cells(line));
      else err(i, "表格前面要有步驟或「例子」");
      return;
    }
    const h = headerOf(line);
    if (h) {
      if (h.kind === "feature") { feature.name = h.name; feature.tags = tags; }
      else if (h.kind === "rule") { inRule = true; ruleBg = []; }
      else if (h.kind === "background") { cur = { steps: inRule ? ruleBg : feature.background }; mode = "bg"; }
      else if (h.kind === "scenario" || h.kind === "outline") {
        cur = { name: h.name, line: i + 1, tags: [...feature.tags, ...tags], outline: h.kind === "outline",
                background: inRule ? ruleBg : null, steps: [], examples: [] };
        feature.scenarios.push(cur); mode = "steps";
      } else if (h.kind === "examples") {
        if (!cur || !cur.outline) err(i, "「例子」要放在「場景大綱」底下");
        examples = { name: h.name, tags, header: null, rows: [] }; cur.examples.push(examples); mode = "examples";
      }
      tags = []; lastStep = null;
      return;
    }
    const s = stepOf(line);
    if (s) {
      if (!cur) err(i, "步驟前面要有「場景」或「背景」");
      if (mode === "examples") err(i, "「例子」表格後面不能再接步驟");
      lastStep = { ...s, line: i + 1 }; cur.steps.push(lastStep);
      return;
    }
    if (cur && mode !== "examples" && !lastStep) return;   // 場景標題下的說明文字
    if (!cur) return;                                       // 功能標題下的說明文字
    err(i, `看不懂這一行：「${line}」`);
  });
  // 展開場景大綱
  const out = [];
  for (const sc of feature.scenarios) {
    const bg = [...feature.background, ...(sc.background || [])];
    if (!sc.outline) { out.push({ name: sc.name, line: sc.line, tags: sc.tags, steps: [...bg, ...sc.steps] }); continue; }
    sc.examples.forEach((ex) => ex.rows.forEach((row, r) => {
      const sub = (t) => t.replace(/<([^>]+)>/g, (m, k) => { const j = ex.header.indexOf(k.trim()); return j < 0 ? m : row[j]; });
      out.push({
        name: `${sub(sc.name)}（例子 ${r + 1}：${row.join("、")}）`, line: sc.line, tags: sc.tags,
        steps: [...bg, ...sc.steps.map((st) => ({ ...st, text: sub(st.text),
          table: st.table && st.table.map((rr) => rr.map(sub)), docString: st.docString && sub(st.docString) }))],
      });
    }));
  }
  feature.scenarios = out;
  return feature;
}

function collectFeatures(only) {
  if (!fs.existsSync(FEATURE_DIR)) return [];
  const files = fs.readdirSync(FEATURE_DIR).filter((f) => /\.(feature|md)$/i.test(f) && !/^readme\.md$/i.test(f) && !f.startsWith("_")).sort();
  const picked = only.length ? files.filter((f) => only.some((o) => path.basename(o) === f)) : files;
  const sources = [];
  for (const f of picked) {
    const full = path.join(FEATURE_DIR, f);
    const text = fs.readFileSync(full, "utf8");
    if (/\.feature$/i.test(f)) sources.push({ file: f, text });
    else {
      const blocks = [...text.matchAll(/```\s*(?:gherkin|feature|cucumber)\s*\n([\s\S]*?)```/gi)].map((m) => m[1]);
      blocks.forEach((b, k) => sources.push({ file: blocks.length > 1 ? `${f}#${k + 1}` : f, text: b }));
    }
  }
  return sources;
}

// ---------- 步驟定義 ----------
function toRegex(p) {
  if (p instanceof RegExp) return p;
  const esc = p.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp("^" + esc
    .replace(/\{string\}/g, "[「“\"']([^」”\"']*)[」”\"']")
    .replace(/\{int\}/g, "(-?\\d+)")
    .replace(/\{float\}/g, "(-?\\d+(?:\\.\\d+)?)")
    .replace(/\{word\}/g, "(\\S+)") + "$");
}
function loadSteps() {
  const defs = [];
  if (!fs.existsSync(STEP_DIR)) return defs;
  for (const f of fs.readdirSync(STEP_DIR).filter((x) => x.endsWith(".cjs")).sort()) {
    const mod = require(path.join(STEP_DIR, f));
    for (const d of mod) defs.push({ re: toRegex(d.pattern), run: d.run, src: f });
  }
  return defs;
}
function match(defs, text) {
  const hits = defs.map((d) => ({ d, m: text.match(d.re) })).filter((x) => x.m);
  if (hits.length > 1) return { error: `有 ${hits.length} 個步驟定義都符合（${hits.map((h) => h.d.src).join("、")}），請刪掉重複的` };
  if (!hits.length) return null;
  const args = hits[0].m.slice(1).filter((a) => a !== undefined).map((a) => (/^-?\d+(\.\d+)?$/.test(a) ? Number(a) : a));
  return { def: hits[0].d, args };
}

// ---------- 給步驟定義用的小工具 ----------
function helpers(page) {
  const field = async (name) => {
    const tries = [page.getByLabel(name, { exact: false }), page.getByPlaceholder(name), page.locator(`[name="${name}"], #${CSS.escape(name)}`)];
    for (const t of tries) if (await t.count()) return t.first();
    throw new Error(`找不到叫「${name}」的欄位（用標籤、提示文字、name 或 id 都找不到）`);
  };
  const CSS = { escape: (s) => s.replace(/[^\w-]/g, "\\$&") };
  return {
    page,
    field,
    async fill(name, value) { await (await field(name)).fill(String(value)); },
    async select(name, value) { await (await field(name)).selectOption({ label: String(value) }).catch(async () => (await field(name)).selectOption(String(value))); },
    async click(text) {
      const tries = [page.getByRole("button", { name: text }), page.getByRole("link", { name: text }), page.getByText(text, { exact: true })];
      for (const t of tries) if (await t.count()) return t.first().click();
      throw new Error(`找不到可以按的「${text}」`);
    },
    async see(text) { await page.getByText(String(text)).first().waitFor({ state: "visible", timeout: 3000 }).catch(() => { throw new Error(`畫面上沒看到「${text}」`); }); },
    async notSee(text) { if (await page.getByText(String(text)).filter({ visible: true }).count()) throw new Error(`畫面上不應該出現「${text}」`); },
    async valueOf(name) { return (await field(name)).inputValue(); },
  };
}

// ---------- 執行 ----------
function sha(files) {
  const h = crypto.createHash("sha256");
  for (const f of files) if (fs.existsSync(f)) h.update(f + "\0" + fs.readFileSync(f));
  return h.digest("hex").slice(0, 16);
}
function fingerprint() {
  const feats = fs.existsSync(FEATURE_DIR) ? fs.readdirSync(FEATURE_DIR).filter((f) => /\.(feature|md)$/i.test(f) && !/^readme\.md$/i.test(f) && !f.startsWith("_")).sort().map((f) => path.join(FEATURE_DIR, f)) : [];
  const steps = fs.existsSync(STEP_DIR) ? fs.readdirSync(STEP_DIR).sort().map((f) => path.join(STEP_DIR, f)) : [];
  return { site: sha([SITE]), features: sha(feats), steps: sha(steps) };
}
module.exports = { parse, fingerprint, collectFeatures };

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry");
  const only = argv.filter((a) => !a.startsWith("--"));
  const sources = collectFeatures(only);
  if (!sources.length) { console.log("docs/features/ 裡沒有 Gherkin 情境，不需要驗收。"); return 0; }

  const features = [], parseErrors = [];
  for (const s of sources) { try { features.push(parse(s.text, s.file)); } catch (e) { parseErrors.push(e.message); } }
  const defs = loadSteps();

  let browser = null;
  if (!dry) {
    let chromium;
    try { ({ chromium } = require("playwright")); }
    catch { console.error("這台機器沒有 Playwright，無法開瀏覽器。請講師確認雲端環境（預設映像檔有內建）。"); return 2; }
    browser = await chromium.launch();
  }
  const results = [];
  for (const f of features) for (const sc of f.scenarios) {
    const r = { file: f.file, feature: f.name, scenario: sc.name, line: sc.line, status: "passed", steps: [] };
    let ctx = null, page = null, h = null;
    if (browser) {
      ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });   // 手機尺寸
      page = await ctx.newPage(); page.setDefaultTimeout(3000);
      r.pageErrors = []; page.on("pageerror", (e) => r.pageErrors.push(e.message));
      await page.goto("file://" + SITE);
      h = helpers(page);
    }
    for (const st of sc.steps) {
      const label = `${st.keyword} ${st.text}`;
      if (r.status !== "passed") { r.steps.push({ label, status: "skipped" }); continue; }
      const m = match(defs, st.text);
      if (!m) { r.status = "undefined"; r.steps.push({ label, status: "undefined", error: "還沒有步驟定義（請 tester 在 tests/steps/ 補上）" }); continue; }
      if (m.error) { r.status = "failed"; r.steps.push({ label, status: "failed", error: m.error }); continue; }
      if (dry) { r.steps.push({ label, status: "defined" }); continue; }
      try { await m.def.run({ ...h, table: st.table, docString: st.docString }, ...m.args); r.steps.push({ label, status: "passed" }); }
      catch (e) { r.status = "failed"; r.steps.push({ label, status: "failed", error: String(e.message || e).split("\n")[0] }); }
    }
    if (dry && r.status === "passed") r.status = "defined";
    if (ctx) await ctx.close();
    results.push(r);
  }
  if (browser) await browser.close();

  const count = (s) => results.filter((r) => r.status === s).length;
  const total = results.length, passed = count("passed");
  const ok = !dry && !parseErrors.length && total > 0 && passed === total;
  const icon = { passed: "✅", failed: "❌", undefined: "❓", defined: "🔍" };
  let md = `# Gherkin 驗收結果\n\n- 時間：${new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}\n`;
  md += `- 結果：${dry ? "（只檢查步驟定義，沒有開瀏覽器）" : ok ? "全部通過 ✅" : "沒有全部通過 ❌"}　通過 ${passed}／共 ${total} 個情境`;
  md += count("failed") ? `，失敗 ${count("failed")}` : "";
  md += count("undefined") ? `，缺步驟定義 ${count("undefined")}` : "";
  md += "\n";
  if (parseErrors.length) md += `\n## 格式看不懂的檔案\n\n${parseErrors.map((e) => `- ${e}`).join("\n")}\n`;
  let lastFile = null;
  for (const r of results) {
    if (r.file !== lastFile) { md += `\n## ${r.file}：${r.feature}\n\n`; lastFile = r.file; }
    md += `- ${icon[r.status] || ""} ${r.scenario}\n`;
    for (const s of r.steps) if (s.error) md += `  - 卡在「${s.label}」：${s.error}\n`;
    if (r.pageErrors && r.pageErrors.length) md += `  - 網頁的 JavaScript 錯誤：${r.pageErrors.join("；")}\n`;
  }
  console.log(md);
  if (!dry && !only.length) {
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULT_DIR, "latest.md"), md);
    fs.writeFileSync(path.join(RESULT_DIR, "latest.json"), JSON.stringify({ ok, passed, total, fingerprint: fingerprint(), parseErrors, results }, null, 2));
  }
  return ok || dry ? 0 : 1;
}
if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
