// 靜態部落格建置腳本
// posts/*.md  →  dist/<slug>/index.html（文章）
// pages/*.md  →  dist/<name>/index.html（關於、門診與掛號等固定頁）
// 分類頁       →  dist/<category slug>/index.html
// 首頁卡片列表在建置時直接寫入 dist/index.html（不靠前端 JS 讀 JSON）
// 更新日期：取該 md 檔最後一次 git commit 時間；尚未 commit 的修改則視為「現在」

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, existsSync, rmSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { marked } from 'marked';

const ROOT = new URL('.', import.meta.url).pathname;
const OUT = join(ROOT, 'dist');
const POSTS_DIR = join(ROOT, 'posts');
const PAGES_DIR = join(ROOT, 'pages');
const site = JSON.parse(readFileSync(join(ROOT, 'site.config.json'), 'utf8'));

// 靜態檔加上內容雜湊當版本號，改了樣式就換網址，瀏覽器不會吃到舊快取
const ver = (file) => createHash('md5').update(readFileSync(join(ROOT, 'static', file))).digest('hex').slice(0, 8);
const ASSET = { css: `/style.css?v=${ver('style.css')}`, js: `/views.js?v=${ver('views.js')}`, icon: `/favicon.svg?v=${ver('favicon.svg')}` };

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

const catByName = Object.fromEntries(site.categories.map((c) => [c.name, c]));

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

    const category = catByName[meta.category] || null;
    if (meta.category && !category) console.warn(`${file}：分類「${meta.category}」不在 site.config.json 的 categories 裡`);

    const image = meta.image === 'none' ? null : (meta.image || site.postImage.src);
    const ogImage = meta.og_image || null; // 分享縮圖；沒填就用文章主圖
    posts.push({
      slug,
      title: meta.title || slug,
      author: meta.author || site.author,
      category,
      summary,
      image,
      imageAlt: meta.image_alt || (meta.image ? meta.title : site.postImage.alt),
      imageCredit: meta.image_credit || (meta.image ? '' : heroCreditInline()),
      ogImage,
      cardImage: ogImage || image || site.postImage.src, // 卡片縮圖
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

// ---------- 讀取固定頁 ----------
function loadPages() {
  if (!existsSync(PAGES_DIR)) return [];
  return readdirSync(PAGES_DIR).filter((f) => f.endsWith('.md')).map((file) => {
    const slug = basename(file, '.md');
    const { meta, body } = parseFrontmatter(readFileSync(join(PAGES_DIR, file), 'utf8'));
    return { slug, title: meta.title || slug, description: meta.description || '', html: renderMarkdown(body), url: `${site.url}/${slug}/` };
  });
}

// ---------- 版型片段 ----------
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

const chip = (c) => c ? `<a class="chip" href="/${esc(c.slug)}/">${esc(c.name)}</a>` : '';

function card(p) {
  return `
      <article class="card">
        <a class="card-media" href="/${esc(p.slug)}/" aria-hidden="true" tabindex="-1">
          <img src="${esc(p.cardImage)}" alt="" loading="lazy">
        </a>
        <div class="card-body">
          <div class="chips">${chip(p.category)}</div>
          <h3 class="card-title"><a href="/${esc(p.slug)}/">${esc(p.title)}</a></h3>
          <p class="card-summary">${esc(p.summary)}</p>
          ${dateMeta(p)}
        </div>
      </article>`;
}

function navHtml(current = '') {
  return site.nav.map((n) => `<a href="${esc(n.href)}"${n.href === current ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('\n        ');
}

function layout({ title, description, canonical, body, bodyAttrs = '', ogImage, ogType = 'website', head = '', current = '' }) {
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
<meta name="theme-color" content="#0b5563">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/feed.xml">
<link rel="icon" href="${ASSET.icon}" type="image/svg+xml">
<link rel="stylesheet" href="${ASSET.css}">
${head}</head>
<body${bodyAttrs}>
<a class="skip" href="#main">跳到主要內容</a>
<header class="topbar">
  <div class="wrap topbar-inner">
    <a class="brand" href="/">${esc(site.brand)}<span class="brand-sub">${esc(site.title)}</span></a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" hidden>
    <label for="nav-toggle" class="nav-btn" aria-label="開啟選單"><span></span><span></span><span></span></label>
    <nav class="nav" aria-label="主選單">
        ${navHtml(current)}
    </nav>
  </div>
</header>
${body}
<footer class="footer">
  <div class="wrap footer-main">
    <div class="footer-brand">
      <strong>${esc(site.title)}</strong><span>${esc(site.subtitle)}</span>
      <p>${esc(site.tagline)}</p>
    </div>
    <nav class="footer-nav" aria-label="頁尾選單">
      <a href="/">首頁</a>
      ${navHtml()}
    </nav>
  </div>
  <div class="wrap footer-sub">
    <p>© ${new Date().getFullYear()} ${esc(site.title)}｜${esc(site.subtitle)}。文章內容為一般衛教資訊，不能取代醫師當面診察；有任何症狀請就醫。</p>
    <p class="credit">文章預設主視覺${heroCreditInline()}</p>
  </div>
</footer>
<script src="${ASSET.js}" defer></script>
</body>
</html>
`;
}

// ---------- 各頁 ----------
function renderIndex(posts) {
  const lastUpdated = posts.length ? fmtDate(posts[0].updated) : fmtDate(new Date());
  const topics = site.categories.map((c) => {
    const n = posts.filter((p) => p.category?.slug === c.slug).length;
    return `
      <a class="topic" href="/${esc(c.slug)}/">
        <span class="topic-icon" aria-hidden="true">${c.icon}</span>
        <span class="topic-body">
          <span class="topic-name">${esc(c.name)}</span>
          <span class="topic-desc">${esc(c.desc)}</span>
          <span class="topic-count">${n} 篇文章 →</span>
        </span>
      </a>`;
  }).join('');

  const body = `
<section class="hero">
  <div class="hero-media">
    <img src="${esc(site.hero.src)}" alt="${esc(site.hero.alt)}" width="${site.hero.width}" height="${site.hero.height}" fetchpriority="high">
  </div>
  <div class="wrap hero-inner">
    <div class="hero-text">
      <p class="hero-kicker">${esc(site.subtitle)}</p>
      <h1>${esc(site.title)}</h1>
      <p class="hero-tagline">${esc(site.tagline)}</p>
      <p class="hero-intro">${esc(site.intro)}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="/ent/">看衛教文章</a>
        <a class="btn btn-ghost" href="/clinic/">門診與掛號</a>
      </div>
    </div>
  </div>
</section>
<main id="main">
  <section class="section">
    <div class="wrap">
      <h2 class="section-title">文章分類</h2>
      <div class="topics">${topics}
      </div>
    </div>
  </section>
  <section class="section section-tint">
    <div class="wrap">
      <div class="section-head">
        <h2 class="section-title">最新文章</h2>
        <p class="site-updated">網站最後更新 <time datetime="${posts.length ? posts[0].updated.toISOString() : ''}">${lastUpdated}</time></p>
      </div>
      <div class="cards">${posts.map(card).join('\n') || '<p>尚未有文章。</p>'}
      </div>
    </div>
  </section>
</main>`;

  return layout({
    title: '',
    description: `${site.title} ${site.subtitle}｜${site.tagline}。${site.intro}`,
    canonical: `${site.url}/`,
    body,
    current: '/',
  });
}

function renderCategory(c, posts) {
  const list = posts.filter((p) => p.category?.slug === c.slug);
  const body = `
<main id="main">
  <section class="page-head">
    <div class="wrap">
      <nav class="crumbs"><a href="/">首頁</a> › ${esc(c.name)}</nav>
      <h1>${c.icon} ${esc(c.name)}</h1>
      <p class="page-lead">${esc(c.desc)}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap">
      <div class="cards">${list.map(card).join('\n') || '<p>這個分類還沒有文章。</p>'}
      </div>
    </div>
  </section>
</main>`;
  return layout({ title: c.name, description: c.desc, canonical: `${site.url}/${c.slug}/`, body, current: `/${c.slug}/` });
}

function renderPage(pg) {
  const body = `
<main id="main">
  <section class="page-head">
    <div class="wrap">
      <nav class="crumbs"><a href="/">首頁</a> › ${esc(pg.title)}</nav>
      <h1>${esc(pg.title)}</h1>
    </div>
  </section>
  <section class="section">
    <div class="wrap post-wrap">
      <div class="post-body">
${pg.html}
      </div>
    </div>
  </section>
</main>`;
  return layout({ title: pg.title, description: pg.description, canonical: pg.url, body, current: `/${pg.slug}/` });
}

function renderPost(p) {
  const figure = p.image ? `
    <figure class="post-hero">
      <img src="${esc(p.image)}" alt="${esc(p.imageAlt)}">
      ${p.imageCredit ? `<figcaption>${p.imageCredit}</figcaption>` : ''}
    </figure>` : '';

  const body = `
<main id="main" class="wrap post-wrap">
  <nav class="crumbs"><a href="/">首頁</a>${p.category ? ` › <a href="/${esc(p.category.slug)}/">${esc(p.category.name)}</a>` : ''}</nav>
  <article class="post">
    <header class="post-head">
      <div class="chips">${chip(p.category)}</div>
      <h1>${esc(p.title)}</h1>
      ${dateMeta(p)}
    </header>
    ${figure}
    <div class="post-body">
${p.html}
    </div>
  </article>
</main>`;

  // 給搜尋引擎的結構化資料（BlogPosting）
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.summary,
    image: (p.ogImage || p.image) ? [site.url + (p.ogImage || p.image)] : undefined,
    datePublished: p.published.toISOString(),
    dateModified: p.updated.toISOString(),
    author: { '@type': 'Person', name: p.author },
    publisher: { '@type': 'Organization', name: `${site.title} ${site.subtitle}`, url: site.url },
    mainEntityOfPage: p.url,
    inLanguage: site.lang,
    articleSection: p.category?.name,
  };
  const head = `<meta property="article:published_time" content="${p.published.toISOString()}">
<meta property="article:modified_time" content="${p.updated.toISOString()}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
`;

  return layout({
    title: p.title,
    description: p.summary,
    canonical: p.url,
    body,
    bodyAttrs: ` data-post="${esc(p.slug)}"`,
    ogImage: p.ogImage || p.image,
    ogType: 'article',
    head,
    current: p.category ? `/${p.category.slug}/` : '',
  });
}

function renderSitemap(posts, pages) {
  const rows = [
    `  <url><loc>${esc(site.url)}/</loc></url>`,
    ...site.categories.map((c) => `  <url><loc>${esc(site.url)}/${c.slug}/</loc></url>`),
    ...pages.map((pg) => `  <url><loc>${esc(pg.url)}</loc></url>`),
    ...posts.map((p) => `  <url><loc>${esc(p.url)}</loc><lastmod>${fmtDate(p.updated)}</lastmod></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
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
const pages = loadPages();
writeFileSync(join(OUT, 'index.html'), renderIndex(posts));
for (const p of posts) {
  mkdirSync(join(OUT, p.slug), { recursive: true });
  writeFileSync(join(OUT, p.slug, 'index.html'), renderPost(p));
}
for (const c of site.categories) {
  mkdirSync(join(OUT, c.slug), { recursive: true });
  writeFileSync(join(OUT, c.slug, 'index.html'), renderCategory(c, posts));
}
for (const pg of pages) {
  mkdirSync(join(OUT, pg.slug), { recursive: true });
  writeFileSync(join(OUT, pg.slug, 'index.html'), renderPage(pg));
}
writeFileSync(join(OUT, 'sitemap.xml'), renderSitemap(posts, pages));
writeFileSync(join(OUT, 'feed.xml'), renderFeed(posts));
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`);
writeFileSync(join(OUT, '404.html'), layout({
  title: '找不到頁面',
  description: '找不到這個頁面',
  canonical: `${site.url}/404`,
  body: `<main id="main" class="wrap post-wrap"><h1>找不到頁面</h1><p>這個網址不存在，<a href="/">回首頁</a>看看最新文章。</p></main>`,
}));

console.log(`建置完成：${posts.length} 篇文章、${site.categories.length} 個分類、${pages.length} 個固定頁`);
for (const p of posts) console.log(`  /${p.slug}/  [${p.category?.name || '未分類'}]  發布 ${fmtDate(p.published)}  更新 ${fmtDate(p.updated)}  ${p.title}`);
