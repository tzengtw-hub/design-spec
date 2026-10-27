// 常用步驟定義。tester 可以照這個樣子，在 tests/steps/ 新增檔案（例如 001-比價.cjs）。
//
// 寫法：{ pattern, run }
//   pattern：步驟的文字。{string} 代表「引號裡的字」，{int} 整數，{float} 小數，{word} 一個詞。
//            也可以直接寫正規表示式，例如 /^我有 (\d+) 家供應商$/
//   run：要做的事。第一個參數是小工具 t，後面依序是 pattern 抓到的值。
//
// 小工具 t：
//   t.page              Playwright 的 page（需要時才用）
//   t.fill(欄位, 值)     在欄位輸入（欄位用標籤文字、提示文字、name 或 id 找）
//   t.select(欄位, 選項) 下拉選單選一項
//   t.click(文字)        按下按鈕或連結
//   t.see(文字)          畫面上要看得到這段字，看不到就算失敗
//   t.notSee(文字)       畫面上不能出現這段字
//   t.valueOf(欄位)      讀欄位目前的值
//   t.table             步驟底下的表格（二維陣列，第一列通常是標題）
//   t.docString         步驟底下的多行文字
//
// 判斷對錯：不符合時 throw new Error("白話的原因")。
const assert = require("node:assert/strict");

module.exports = [
  { pattern: "我打開網站", run: async () => {} },                 // 每個情境開始時網站已經打開
  { pattern: "I open the website", run: async () => {} },
  { pattern: "我在{string}輸入{string}", run: (t, field, value) => t.fill(field, value) },
  { pattern: "我在{string}選擇{string}", run: (t, field, value) => t.select(field, value) },
  { pattern: "我按下{string}", run: (t, text) => t.click(text) },
  { pattern: "我按{string}", run: (t, text) => t.click(text) },
  { pattern: "畫面上應該顯示{string}", run: (t, text) => t.see(text) },
  { pattern: "我應該看到{string}", run: (t, text) => t.see(text) },
  { pattern: "畫面上不應該顯示{string}", run: (t, text) => t.notSee(text) },
  { pattern: "網頁標題應該是{string}", run: async (t, title) => assert.equal(await t.page.title(), title, `網頁標題不是「${title}」`) },
  { pattern: "{string}欄位的值應該是{string}", run: async (t, field, value) => assert.equal(await t.valueOf(field), value, `「${field}」的值不是「${value}」`) },
];
