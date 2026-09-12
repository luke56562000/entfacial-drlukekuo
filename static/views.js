// 瀏覽計數：文章頁 +1 並顯示；首頁一次讀取所有卡片的次數
(async () => {
  const els = document.querySelectorAll('[data-views]');
  if (!els.length) return;
  const show = (slug, n) => {
    for (const el of document.querySelectorAll(`[data-views="${slug}"]`)) el.textContent = Number(n).toLocaleString('zh-Hant-TW');
  };
  const store = { get(k) { try { return sessionStorage.getItem(k); } catch { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch {} } };
  try {
    const post = document.body.dataset.post;
    if (post) {
      // 同一個瀏覽分頁重新整理不重複計數
      const key = 'viewed:' + post;
      const method = store.get(key) ? 'GET' : 'POST';
      const r = await fetch(`/api/views/${post}`, { method });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      store.set(key, '1');
      show(post, j.views);
    } else {
      const slugs = [...new Set([...els].map((e) => e.dataset.views))];
      const r = await fetch('/api/views?slugs=' + encodeURIComponent(slugs.join(',')));
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      for (const s of slugs) show(s, j[s] ?? 0);
    }
  } catch {
    for (const el of els) el.textContent = '–';
  }
})();
