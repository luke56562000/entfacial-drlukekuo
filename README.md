# 路克醫師 郭哲宏｜耳鼻喉顏面外科

Dr. Luke Kuo — ENT & Facial Plastic Surgery blog

- 網站：https://entfacial.drlukekuo.com（Pages 預設網址：https://entfacial-drlukekuo.pages.dev）
- 主機：Cloudflare Pages（與此 GitHub repo 連動，push 到 `main` 就自動部署）
- 瀏覽計數：Cloudflare Pages Functions + KV（`functions/api/views*`）

## 新增文章

1. 在 `posts/` 新增一個 Markdown 檔，檔名格式 `YYYYMMDD-英文短名.md`（只能用小寫英數與 `-`），
   檔名就是網址：`posts/20260912-welcome.md` → `https://entfacial.drlukekuo.com/20260912-welcome/`
2. 檔案開頭放 frontmatter：

   ```
   ---
   title: 文章標題
   date: 2026-09-12
   author: 郭哲宏 醫師
   summary: 一到兩句摘要（顯示在首頁卡片）
   image: /assets/my-photo.jpg      # 可省略；省略＝用網站預設文章圖（CC BY 喉嚨檢查照）；填 none＝不放圖
   og_image: /assets/share.jpg      # 可省略；社群分享縮圖，沒填就用 image
   image_alt: 圖片說明
   image_credit: 圖片出處（可含 HTML 連結）
   ---
   ```

3. 下面用 Markdown 寫內文。圖片放到 `assets/` 資料夾，用 `![說明](/assets/檔名.jpg)` 引用。
4. `git add . && git commit -m "新增文章" && git push` → Cloudflare Pages 會自動重建並上線。

- **發布日期**：`date` 欄位（沒填就從檔名推）。
- **更新日期**：自動取該檔最後一次 git commit 的時間，修改文章後 push 就會更新，首頁卡片也會依更新日期重新排序（最新在前）。
- 想暫時不公開：frontmatter 加 `draft: true`。

## 本機預覽

```bash
npm install
npm run dev     # 建置後用 wrangler 在本機跑，含瀏覽計數 API（本機用假的 KV）
```

## 專案結構

```
posts/            文章 Markdown
assets/           文章用圖片
static/           樣式、主視覺、計數器前端腳本
functions/        Cloudflare Pages Functions（瀏覽計數 API）
build.js          建置腳本：Markdown → dist/
site.config.json  網站名稱、標語、主視覺與圖片授權資訊
wrangler.toml     Cloudflare 設定（輸出目錄、KV 綁定）
```
