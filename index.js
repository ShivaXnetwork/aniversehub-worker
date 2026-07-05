/**
 * AniverseHub proxy Worker.
 *
 * Why this exists: AniList sits behind Cloudflare, which flags Vercel's
 * shared serverless IPs as datacenter/bot traffic (403s), even with
 * correct headers. A Cloudflare Worker runs *on* Cloudflare's own
 * network, so a Worker-to-AniList request looks like normal
 * Cloudflare-to-Cloudflare traffic and isn't blocked.
 *
 * This also edge-caches responses (via the Workers Cache API), so most
 * requests never even reach AniList/Jikan — further cutting the chance
 * of ever being rate-limited or blocked.
 *
 * Routes:
 *   GET /anilist?query=<urlencoded graphql>&variables=<urlencoded json>
 *   GET /jikan/<path>?<querystring>   e.g. /jikan/anime?q=Naruto&limit=1
 */

const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6h — matches backend's Mongo TTL

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // this Worker only ever talks to our own backend, not browsers directly
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cachedJsonFetch(cacheKey, doFetch) {
  const cache = caches.default;
  let response = await cache.match(cacheKey);
  if (response) return response;

  const originRes = await doFetch();
  const body = await originRes.text();

  response = new Response(body, {
    status: originRes.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      ...corsHeaders(),
    },
  });

  // Only cache successful responses — don't lock in a transient 4xx/5xx.
  if (originRes.status >= 200 && originRes.status < 300) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

async function handleAnilist(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('query');
  const variablesRaw = url.searchParams.get('variables') || '{}';

  if (!query) {
    return new Response(JSON.stringify({ error: 'Missing query param' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  let variables;
  try {
    variables = JSON.parse(variablesRaw);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid variables JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
  }

  // Cache key = the exact incoming GET URL (query+variables fully identify
  // the request), so identical calls hit the Worker's edge cache.
  const cacheKey = new Request(url.toString(), request);

  return cachedJsonFetch(cacheKey, () =>
    fetchWithTimeout('https://graphql.anilist.co', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }, 8000)
  );
}

async function handleJikan(request) {
  const url = new URL(request.url);
  const jikanPath = url.pathname.replace(/^\/jikan/, ''); // e.g. /anime
  const jikanUrl = `https://api.jikan.moe/v4${jikanPath}${url.search}`;

  const cacheKey = new Request(url.toString(), request);

  return cachedJsonFetch(cacheKey, () =>
    fetchWithTimeout(jikanUrl, { headers: { Accept: 'application/json' } }, 7000)
  );
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Only GET is supported' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/anilist') return await handleAnilist(request);
      if (url.pathname.startsWith('/jikan/')) return await handleJikan(request);

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || String(err) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }
  },
};
