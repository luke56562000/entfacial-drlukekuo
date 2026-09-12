// GET /api/views?slugs=a,b,c → { a: 12, b: 3, c: 0 }（首頁卡片用）
import { SLUG, json } from '../_lib.js';

export async function onRequestGet({ request, env }) {
  const slugs = [...new Set((new URL(request.url).searchParams.get('slugs') || '').split(','))]
    .filter((s) => SLUG.test(s))
    .slice(0, 100);
  const entries = await Promise.all(slugs.map(async (s) => [s, Number(await env.VIEWS.get(s)) || 0]));
  return json(Object.fromEntries(entries));
}
