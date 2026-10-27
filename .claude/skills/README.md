# skills（技能）資料夾

這個資料夾目前是空的，本課程不使用任何 skill。放在這裡只是讓你知道：**如果有 skill，就放這裡。**

## skill 是什麼

skill 是一份「遇到某類工作時才拿出來看的作業手冊」。
平常 Claude 只看得到每份 skill 的名稱和一句說明；等你交代的事情剛好對上，它才打開整份來照做。

## 放法

每個 skill 一個資料夾，裡面一定要有一個 `SKILL.md`：

```
.claude/skills/
└── 報價單格式/
    └── SKILL.md      ← 開頭寫名稱與「什麼時候用」，下面寫步驟
```

（這份 README.md 不是 skill，Claude 不會把它當成 skill 讀。）

## 跟這個範本裡其他東西的差別

| 放在哪 | 是什麼 | 什麼時候生效 |
|---|---|---|
| `CLAUDE.md` | 員工手冊（總管的規矩） | 每次對話一開始就讀 |
| `.claude/agents/` | 分工：builder、tester、checker | 總管派工時 |
| `.claude/hooks/` | 門禁：擋錯誤動作 | 每個動作前後自動檢查 |
| `.claude/skills/` | 作業手冊：特定工作的做法 | 工作內容對上時才拿出來 |
