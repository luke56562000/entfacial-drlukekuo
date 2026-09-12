// 靜態部落格建置腳本
// posts/*.md  →  dist/<slug>/index.html
// 首頁卡片列表在建置時直接寫入 dist/index.html（不靠前端 JS 讀 JSON）
// 更新日期：取該 md 檔最後一次 git commit 時間；尚未 commit 的修改則視為「現在」

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, existsSync, rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { marked } from 'marked';

const ROOT = new URL('.', import.meta.url).pathname;
const OUT = join(ROOT, 'dist');
const POSTS_DIR = join(ROOT, 'posts');
const site = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));

// ---------- git 工具 ----------
function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}
// Cloudflare Pages 會做 shallow clone，先把完整歷史抓回來才能算出正確的更新日期
if (git('rev-parse --is-shallow-repository') === 'true') git('fetch --unshallow --quiet');

function lastCommitDate(relPath) {
  const iso = git(`log -1 --format=%cI -- "${relPath}"`);
  return iso ? new Date(iso) : null;
}
function isDirty(relPath) {
  return git(`status --porcelain -- "${relPath}"`) !== '';
}

// ---------- 小工具 ----------
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmtDate = (d) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d); // → YYYY-MM-DD

function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { meta, body: m[2] };
}

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md) {
  return marked.parse(md)
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>')
    .replace(/<img /g, '<img loading="lazy" ');
}

// ---------- 讀取文章 ----------
function loadPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md')).sort();
  const posts = [];
  for (const file of files) {
    const rel = `posts/${file}`;
    const slug = basename(file, '.md');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      console.warn(`略過 ${file}：檔名只能用小寫英數與連字號（例：20260912-my-post.md）`);
      continue;
    }
    const { meta, body } = parseFrontmatter(readFileSync(join(POSTS_DIR, file), 'utf8'));
    if (meta.draft === 'true') continue;

    // 發布日期：frontmatter 的 date，沒有就從檔名 YYYYMMDD 推
    let published = meta.date ? new Date(meta.date) : null;
    if (!published || isNaN(published)) {
      const m = slug.match(/^(\d{4})(\d{2})(\d{2})/);
      published = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`) : new Date();
    }

    // 更新日期：有未 commit 的修改 → 現在；否則取最後 commit 時間；都沒有 → 發布日期
    let updated = isDirty(rel) ? new Date() : lastCommitDate(rel);
    if (!updated) updated = published;
    if (updated < published) updated = published;

    const html = renderMarkdown(body);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const summary = meta.summary || text.slice(0, 90) + (text.length > 90 ? '…' : '');

    posts.push({
      slug,
      title: meta.title || slug,
      author: meta.author || site.author,
      summary,
      image: meta.image === 'none' ? null : (meta.image || site.postImage.src),
      imageAlt: meta.image_alt || (meta.image ? meta.title : site.postImage.alt),
      imageCredit: meta.image_credit || (meta.image ? '' : heroCreditInline()),
      published,
      updated,
      html,
      url: `${site.url}/${slug}/`,
    });
  }
  // 最新的在前：以更新日期排序，同日再看發布日期
  posts.sort((a, b) => (b.updated - a.updated) || (b.published - a.published));
  return posts;
}

// ---------- 版型 ----------
function heroCreditInline() {
  const h = site.postImage;
  return `照片：<a href="${esc(h.sourceUrl)}" rel="noopener">${esc(h.title)}</a> — `
    + `<a href="${esc(h.authorUrl)}" rel="noopener">${esc(h.author)}</a>，`
    + `<a href="${esc(h.licenseUrl)}" rel="noopener">${esc(h.license)}</a>，via Wikimedia Commons（${esc(h.note)}）`;
}

function dateMeta(p, { withViews = true } = {}) {
  const pub = fmtDate(p.published);
  const upd = fmtDate(p.updated);
  let s = `<span class="meta-item">發布 <time datetime="${p.published.toISOString()}">${pub}</time></span>`;
  if (upd !== pub) s += `<span class="meta-item">更新 <time datetime="${p.updated.toISOString()}">${upd}</time></span>`;
  s += `<span class="meta-item">作者 ${esc(p.author)}</span>`;
  if (withViews) s += `<span class="meta-item"><span class="views" data-views="${esc(p.slug)}">–</span> 次瀏覽</span>`;
  return `<div class="meta">${s}</div>`;
}

function layout({ title, description, canonical, body, bodyAttrs = '', ogImage, ogType = 'website' }) {
  const fullTitle = title ? `${title}｜${site.title} ${site.subtitle}` : `${site.title}｜${site.subtitle}`;
  return `<!doctype html>
<html lang="${esc(site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(site.url + (ogImage || site.ogImage))}">
<meta property="og:site_name" content="${esc(site.title + ' ' + site.subtitle)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/feed.xml">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body${bodyAttrs}>
<a class="skip" href="#main">跳到主要內容</a>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/">${esc(site.title)}<span class="brand-sub">${esc(site.subtitle)}</span></a>
  </div>
</header>
${body}
<footer class="footer">
  <div class="wrap">
    <p>© ${new Date().getFullYear()} ${esc(site.title)}｜${esc(site.subtitle)}。文章內容為一般衛教資訊，不能取代醫師當面診察；有任何症狀請就醫。</p>
    <p class="credit">文章預設主視覺${heroCreditInline()}</p>
  </div>
</footer>
<script src="/views.js" defer></script>
</body>
</html>
`;
}

function renderIndex(posts) {
  const lastUpdated = posts.length ? fmtDate(posts[0].updated) : fmtDate(new Date());
  const cards = posts.map((p) => `
      <article class="card">
        <a class="card-link" href="/${esc(p.slug)}/">
          <h3 class="card-title">${esc(p.title)}</h3>
          <p class="card-summary">${esc(p.summary)}</p>
        </a>
        ${dateMeta(p)}
      </article>`).join('\n');

  const body = `
<section class="hero">
  <div class="hero-inner wrap">
    <div class="hero-text">
      <h1>${esc(site.title)}</h1>
      <p class="hero-sub">${esc(site.subtitle)}</p>
      <p class="hero-tagline">${esc(site.tagline)}</p>
    </div>
    <img class="hero-img" src="${esc(site.portrait.src)}" alt="${esc(site.portrait.alt)}" width="${site.portrait.width}" height="${site.portrait.height}" fetchpriority="high">
  </div>
</section>
<main id="main" class="wrap">
  <div class="section-head">
    <h2>最新文章</h2>
    <p class="site-updated">網站最後更新 <time datetime="${posts.length ? posts[0].updated.toISOString() : ''}">${lastUpdated}</time></p>
  </div>
  <div class="cards">${cards || '<p>尚未有文章。</p>'}
  </div>
</main>`;

  return layout({
    title: '',
    description: `${site.title} ${site.subtitle}｜${site.tagline}`,
    canonical: `${site.url}/`,
    body,
  });
}

function renderPost(p) {
  const figure = p.image ? `
    <figure class="post-hero">
      <img src="${esc(p.image)}" alt="${esc(p.imageAlt)}">
      ${p.imageCredit ? `<figcaption>${p.imageCredit}</figcaption>` : ''}
    </figure>` : '';

  const body = `
<main id="main" class="wrap post-wrap">
  <nav class="crumbs"><a href="/">← 回首頁</a></nav>
  <article class="post">
    <header class="post-head">
      <h1>${esc(p.title)}</h1>
      ${dateMeta(p)}
    </header>
    ${figure}
    <div class="post-body">
${p.html}
    </div>
  </article>
</main>`;

  return layout({
    title: p.title,
    description: p.summary,
    canonical: p.url,
    body,
    bodyAttrs: ` data-post="${esc(p.slug)}"`,
    ogImage: p.image,
    ogType: 'article',
  });
}

function renderSitemap(posts) {
  const urls = [`${site.url}/`, ...posts.map((p) => p.url)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u, i) => `  <url><loc>${esc(u)}</loc>${i ? `<lastmod>${fmtDate(posts[i - 1].updated)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

function renderFeed(posts) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${esc(site.title)}｜${esc(site.subtitle)}</title>
<link>${esc(site.url)}/</link>
<description>${esc(site.tagline)}</description>
${posts.map((p) => `<item><title>${esc(p.title)}</title><link>${esc(p.url)}</link><guid>${esc(p.url)}</guid><pubDate>${p.published.toUTCString()}</pubDate><description>${esc(p.summary)}</description></item>`).join('\n')}
</channel></rss>
`;
}

// ---------- 輸出 ----------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'static'), OUT, { recursive: true });
if (existsSync(join(ROOT, 'assets'))) cpSync(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true });

const posts = loadPosts();
writeFileSync(join(OUT, 'index.html'), renderIndex(posts));
for (const p of posts) {
  mkdirSync(join(OUT, p.slug), { recursive: true });
  writeFileSync(join(OUT, p.slug, 'index.html'), renderPost(p));
}
writeFileSync(join(OUT, 'sitemap.xml'), renderSitemap(posts));
writeFileSync(join(OUT, 'feed.xml'), renderFeed(posts));
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
writeFileSync(join(OUT, '404.html'), layout({
  title: '找不到頁面',
  description: '找不到這個頁面',
  canonical: `${site.url}/404`,
  body: `<main id="main" class="wrap post-wrap"><h1>找不到頁面</h1><p>這個網址不存在，<a href="/">回首頁</a>看看最新文章。</p></main>`,
}));

console.log(`建置完成：${posts.length} 篇文章`);
for (const p of posts) console.log(`  /${p.slug}/  發布 ${fmtDate(p.published)}  更新 ${fmtDate(p.updated)}  ${p.title}`);
