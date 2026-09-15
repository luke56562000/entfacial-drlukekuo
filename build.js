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


// 讀 JPEG / PNG 的像素尺寸（給 og:image:width/height 用，Facebook 第一次分享才會直接顯示圖片）
function imageSize(publicPath) {
  try {
    const file = publicPath.startsWith('/assets/') ? join(ROOT, 'assets', publicPath.slice(8)) : join(ROOT, 'static', publicPath.replace(/^\//, ''));
    const b = readFileSync(file);
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; // PNG
    if (b[0] === 0xff && b[1] === 0xd8) { // JPEG：找 SOF 區段
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
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
${(() => { const sz = imageSize(ogImage || site.ogImage); return sz ? `<meta property="og:image:width" content="${sz.w}">\n<meta property="og:image:height" content="${sz.h}">` : ''; })()}
<meta property="og:image:type" content="image/${(ogImage || site.ogImage).endsWith('.png') ? 'png' : 'jpeg'}">
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


// ---------- Podcast：建置時讀 RSS 與 Apple Podcasts API，失敗則用 podcast.cache.json ----------
const PODCAST_CACHE = join(ROOT, 'podcast.cache.json');
const xmlText = (tag, x) => {
  const m = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
};
const normTitle = (t) => t.replace(/\s+/g, '').replace(/[「」『』（）()｜|？?！!。，,、：:—\-]/g, '').toLowerCase();
const fmtDuration = (sec) => { sec = Number(sec) || 0; const m = Math.round(sec / 60); return m ? `${m} 分鐘` : ''; };

async function loadPodcast() {
  const pc = site.podcast;
  if (!pc) return null;
  let episodes = null;
  try {
    const rss = await (await fetch(pc.rss, { signal: AbortSignal.timeout(20000) })).text();
    const items = rss.match(/<item>[\s\S]*?<\/item>/g) || [];
    episodes = items.map((it) => {
      const enclosure = (it.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || '';
      const bzId = (enclosure.match(/\/episodes\/(\d+)/) || [])[1] || '';
      return {
        id: bzId,
        title: xmlText('title', it),
        date: new Date(xmlText('pubDate', it)),
        duration: xmlText('itunes:duration', it),
        summary: xmlText('itunes:summary', it) || xmlText('description', it),
        page: bzId ? `https://www.buzzsprout.com/${pc.buzzsproutId}/episodes/${bzId}` : xmlText('link', it),
        audio: enclosure,
      };
    });
    // Apple Podcasts 單集連結：用標題比對
    try {
      const j = await (await fetch(`https://itunes.apple.com/lookup?id=${pc.apple.id}&country=TW&entity=podcastEpisode&limit=200`, { signal: AbortSignal.timeout(20000) })).json();
      const apple = (j.results || []).filter((r) => r.kind === 'podcast-episode');
      for (const e of episodes) {
        const hit = apple.find((a) => normTitle(a.trackName) === normTitle(e.title));
        if (hit) e.apple = hit.trackViewUrl;
      }
    } catch (err) { console.warn('Apple Podcasts API 讀取失敗，單集連結改連節目頁：', err.message); }
    writeFileSync(PODCAST_CACHE, JSON.stringify(episodes, null, 2));
  } catch (err) {
    console.warn('Podcast RSS 讀取失敗，改用快取：', err.message);
    if (existsSync(PODCAST_CACHE)) episodes = JSON.parse(readFileSync(PODCAST_CACHE, 'utf8')).map((e) => ({ ...e, date: new Date(e.date) }));
    else return null;
  }
  // 手動補的 Spotify / YouTube 單集連結
  for (const e of episodes) Object.assign(e, pc.episodeLinks?.[e.id] || {});
  episodes.sort((a, b) => b.date - a.date);
  return episodes;
}

const ICON = {
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.6 19.33c-.1-.75-.2-1.9-.05-2.72l.7-3.2c.14-.63.5-1.12 1.1-1.12h3.7c.6 0 .96.5 1.1 1.12l.7 3.2c.15.82.05 1.97-.05 2.72A10 10 0 0 0 12 2Zm0 4.5a3.75 3.75 0 0 1 2.3 6.7 5.9 5.9 0 0 0-4.6 0A3.75 3.75 0 0 1 12 6.5Zm0 1.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Zm0-4a6.5 6.5 0 0 1 4.6 11.1l-1.07-1.07A5 5 0 1 0 8.47 14.03L7.4 15.1A6.5 6.5 0 0 1 12 4Z"/></svg>',
  spotify: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.24 14.5a.75.75 0 0 1-1.03.25c-2.82-1.72-6.37-2.1-10.55-1.15a.75.75 0 1 1-.33-1.46c4.56-1.04 8.48-.6 11.66 1.34.35.21.46.67.25 1.02Zm1.2-2.9a.94.94 0 0 1-1.29.31c-3.23-1.98-8.15-2.56-11.97-1.4a.94.94 0 1 1-.54-1.8c4.36-1.32 9.79-.68 13.5 1.6.44.27.58.85.3 1.29Zm.1-3.02c-3.87-2.3-10.26-2.51-13.96-1.39a1.13 1.13 0 1 1-.65-2.16c4.24-1.29 11.3-1.04 15.76 1.61a1.13 1.13 0 0 1-1.15 1.94Z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.5 6.5a3 3 0 0 0-2.1-2.1C19.5 4 12 4 12 4s-7.5 0-9.4.4A3 3 0 0 0 .5 6.5 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.5 3 3 0 0 0 2.1 2.1C4.5 20 12 20 12 20s7.5 0 9.4-.4a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.5ZM9.6 15.5v-7l6.2 3.5-6.2 3.5Z"/></svg>',
};

function renderPodcast(episodes) {
  const pc = site.podcast;
  const plink = (kind, label, e) => {
    const url = e?.[kind] || pc[kind]?.showUrl;
    if (!url) return '';
    const level = e?.[kind] ? 'episode' : 'show';
    const title = level === 'episode' ? `在 ${label} 收聽這一集` : `在 ${label} 收聽（節目頁）`;
    return `<a class="plink plink-${kind}" data-level="${level}" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}" aria-label="${esc(title)}">${ICON[kind]}</a>`;
  };
  const list = (episodes || []).map((e) => `
      <li class="episode">
        <div class="episode-main">
          <div class="episode-meta"><time datetime="${e.date.toISOString()}">${fmtDate(e.date)}</time>${e.duration ? `<span>${fmtDuration(e.duration)}</span>` : ''}</div>
          <h3 class="episode-title"><a href="${esc(e.page)}" target="_blank" rel="noopener">${esc(e.title)}</a></h3>
        </div>
        <div class="episode-links">${plink('apple', 'Apple Podcasts', e)}${plink('spotify', 'Spotify', e)}${plink('youtube', 'YouTube', e)}</div>
      </li>`).join('');

  const body = `
<main id="main">
  <section class="page-head">
    <div class="wrap">
      <nav class="crumbs"><a href="/">首頁</a> › Podcast</nav>
      <h1>🎙️ ${esc(pc.title)}</h1>
      <p class="page-lead">${pc.desc}</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap post-wrap">
      <div class="pod-platforms">
        <a class="btn btn-primary" href="${esc(pc.apple.showUrl)}" target="_blank" rel="noopener">${ICON.apple} Apple Podcasts</a>
        <a class="btn btn-ghost" href="${esc(pc.spotify.showUrl)}" target="_blank" rel="noopener">${ICON.spotify} Spotify</a>
        <a class="btn btn-ghost" href="${esc(pc.youtube.showUrl)}" target="_blank" rel="noopener">${ICON.youtube} YouTube</a>
      </div>
      <p class="site-updated" style="margin:0 0 20px">點標題可到節目頁收聽；右側圖示直接開啟各平台的該集（淡色圖示表示該平台尚無單集連結，會開啟節目頁）。</p>
      <div class="pod-player"><iframe src="https://www.buzzsprout.com/${esc(pc.buzzsproutId)}?client_source=large_player&iframe=true" loading="lazy" title="${esc(pc.title)} 播放器"></iframe></div>
      <h2 class="section-title">全部集數</h2>
      <ol class="episodes">${list || '<li>目前讀不到集數，請稍後再試。</li>'}
      </ol>
    </div>
  </section>
</main>`;
  return layout({ title: 'Podcast', description: `${pc.title}｜${pc.desc.replace(/<[^>]+>/g, '')}`, canonical: `${site.url}/podcast/`, body, current: '/podcast/' });
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
    ...(site.podcast ? [`  <url><loc>${esc(site.url)}/podcast/</loc></url>`] : []),
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
const episodes = await loadPodcast();
if (site.podcast) {
  mkdirSync(join(OUT, 'podcast'), { recursive: true });
  writeFileSync(join(OUT, 'podcast', 'index.html'), renderPodcast(episodes));
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

console.log(`建置完成：${posts.length} 篇文章、${site.categories.length} 個分類、${pages.length} 個固定頁、Podcast ${episodes?.length ?? 0} 集`);
for (const p of posts) console.log(`  /${p.slug}/  [${p.category?.name || '未分類'}]  發布 ${fmtDate(p.published)}  更新 ${fmtDate(p.updated)}  ${p.title}`);
