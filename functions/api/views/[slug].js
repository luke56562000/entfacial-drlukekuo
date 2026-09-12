// GET  /api/views/<slug>  → 讀取次數
// POST /api/views/<slug>  → 次數 +1
import { SLUG, json } from '../../_lib.js';

async function read(env, slug) {
  return Number(await env.VIEWS.get(slug)) || 0;
}

export async function onRequestGet({ params, env }) {
  const { slug } = params;
  if (!SLUG.test(slug)) return json({ error: 'bad slug' }, 400);
  return json({ slug, views: await read(env, slug) });
}

export async function onRequestPost({ params, env }) {
  const { slug } = params;
  if (!SLUG.test(slug)) return json({ error: 'bad slug' }, 400);
  const views = (await read(env, slug)) + 1;
  await env.VIEWS.put(slug, String(views));
  return json({ slug, views });
}
