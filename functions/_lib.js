export const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
