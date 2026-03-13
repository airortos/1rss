const CACHE_TTL_MINUTES = 30;
const MAX_ITEMS = 25;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1500000;

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      return new Response(homePage(requestUrl.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/feed') {
      const rawTargetUrl = requestUrl.searchParams.get('url');
      if (!rawTargetUrl) {
        return textResponse(
          'Query parameter "url" is required. Example: /feed?url=https://example.com',
          400
        );
      }
      try {
        return await handleFeed(rawTargetUrl, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return textResponse(message, 502);
      }
    }

    return textResponse('Not Found', 404);
  },
};

async function handleFeed(rawTargetUrl, env) {
  const normalized = normalizeTargetUrl(rawTargetUrl);
  if (!normalized.ok) {
    return textResponse(normalized.error, 400);
  }

  const targetUrl = normalized.url;
  const urlKey = await sha256(targetUrl);
  const db = env && env.DB ? env.DB : null;

  if (db) {
    await ensureSchema(db);
    const cached = await getCachedFeed(db, urlKey, CACHE_TTL_MINUTES);
    if (cached) {
      return rssResponse(cached.rss_xml, 'HIT');
    }
  }

  const html = await fetchHtml(targetUrl);
  const links = extractLinksFromHtml(html, targetUrl, MAX_ITEMS);
  const rss = buildRss(targetUrl, links);

  if (db) {
    await upsertFeed(db, {
      urlKey,
      targetUrl,
      rssXml: rss,
      itemCount: links.length,
      updatedAt: new Date().toISOString(),
    });
  }

  return rssResponse(rss, 'MISS');
}

async function ensureSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS feeds (
        url_key TEXT PRIMARY KEY,
        target_url TEXT NOT NULL,
        rss_xml TEXT NOT NULL,
        item_count INTEGER,
        updated_at TEXT NOT NULL
      )`
    )
    .run();
}

async function getCachedFeed(db, urlKey, ttlMinutes) {
  const row = await db
    .prepare('SELECT rss_xml, item_count, updated_at FROM feeds WHERE url_key = ?')
    .bind(urlKey)
    .first();

  if (!row || !row.updated_at) {
    return null;
  }

  const ageMs = Date.now() - Date.parse(row.updated_at);
  const ttlMs = ttlMinutes * 60 * 1000;
  if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
    return null;
  }

  return row;
}

async function upsertFeed(db, { urlKey, targetUrl, rssXml, itemCount, updatedAt }) {
  await db
    .prepare(
      `INSERT INTO feeds (url_key, target_url, rss_xml, item_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url_key) DO UPDATE SET
         target_url = excluded.target_url,
         rss_xml = excluded.rss_xml,
         item_count = excluded.item_count,
         updated_at = excluded.updated_at`
    )
    .bind(urlKey, targetUrl, rssXml, itemCount, updatedAt)
    .run();
}

async function fetchHtml(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': '1rss-worker/1.0 (+https://workers.dev)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    });

    if (!response.ok) {
      throw new Error(`Upstream returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isHtml =
      contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
    if (!isHtml) {
      throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_HTML_BYTES) {
      throw new Error(`HTML too large (${buffer.byteLength} bytes)`);
    }

    return new TextDecoder('utf-8').decode(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown fetch error';
    throw new Error(`Failed to fetch target page: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function extractLinksFromHtml(html, targetUrl, maxItems) {
  const targetHost = new URL(targetUrl).host;
  const seen = new Set();
  const items = [];
  const anchorRegex =
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(html)) !== null) {
    const hrefRaw = match[1] || match[2] || match[3] || '';
    const textRaw = stripTags(match[4] || '').trim();
    const resolved = resolveAndFilterLink(hrefRaw, targetUrl, targetHost);
    if (!resolved) {
      continue;
    }

    const dedupeKey = resolved.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const fallbackTitle = titleFromUrl(resolved);
    const title = sanitizeTitle(textRaw) || fallbackTitle;
    if (!title) {
      continue;
    }

    items.push({
      title,
      link: resolved,
      guid: resolved,
      pubDate: new Date().toUTCString(),
    });

    if (items.length >= maxItems) {
      break;
    }
  }

  if (items.length === 0) {
    items.push({
      title: `No article links were detected on ${targetHost}`,
      link: targetUrl,
      guid: `${targetUrl}#placeholder`,
      pubDate: new Date().toUTCString(),
    });
  }

  return items;
}

function resolveAndFilterLink(rawHref, baseUrl, targetHost) {
  if (!rawHref) {
    return null;
  }
  const href = rawHref.trim();
  if (!href) {
    return null;
  }

  const lowered = href.toLowerCase();
  if (
    lowered.startsWith('#') ||
    lowered.startsWith('javascript:') ||
    lowered.startsWith('mailto:') ||
    lowered.startsWith('tel:') ||
    lowered.startsWith('data:')
  ) {
    return null;
  }

  let absoluteUrl;
  try {
    absoluteUrl = new URL(href, baseUrl);
  } catch {
    return null;
  }

  if (absoluteUrl.protocol !== 'http:' && absoluteUrl.protocol !== 'https:') {
    return null;
  }

  if (absoluteUrl.host !== targetHost) {
    return null;
  }

  const path = absoluteUrl.pathname.toLowerCase();
  if (
    path === '/' ||
    path.includes('/tag/') ||
    path.includes('/category/') ||
    path.includes('/author/') ||
    path.includes('/about') ||
    path.includes('/contact') ||
    path.includes('/privacy') ||
    path.includes('/terms')
  ) {
    return null;
  }

  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp3|mp4|mov|webm)$/i.test(path)) {
    return null;
  }

  absoluteUrl.hash = '';
  return absoluteUrl.toString();
}

function buildRss(targetUrl, items) {
  const source = new URL(targetUrl);
  const now = new Date().toUTCString();
  const channelTitle = `${source.host} - generated feed`;
  const channelDescription = `RSS generated from ${source.host}`;

  const itemXml = items
    .map((item) => {
      return [
        '    <item>',
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(item.link)}</link>`,
        `      <guid>${escapeXml(item.guid)}</guid>`,
        `      <pubDate>${escapeXml(item.pubDate)}</pubDate>`,
        '    </item>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(channelTitle)}</title>`,
    `    <link>${escapeXml(targetUrl)}</link>`,
    `    <description>${escapeXml(channelDescription)}</description>`,
    `    <lastBuildDate>${escapeXml(now)}</lastBuildDate>`,
    itemXml,
    '  </channel>',
    '</rss>',
  ].join('\n');
}

function normalizeTargetUrl(rawValue) {
  let input = String(rawValue || '').trim();
  if (!input) {
    return { ok: false, error: 'Parameter "url" cannot be empty' };
  }

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// are allowed' };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'Credentials in URL are not allowed' };
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    return { ok: false, error: 'Only ports 80 and 443 are allowed' };
  }

  const host = url.hostname.toLowerCase();
  if (isLocalOrPrivateHost(host)) {
    return { ok: false, error: 'Local/private network URLs are not allowed' };
  }

  url.hash = '';
  return { ok: true, url: url.toString() };
}

function isLocalOrPrivateHost(host) {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  if (isIpv4(host)) {
    const parts = host.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 10 || a === 127 || a === 0) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    return false;
  }

  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fd') || host.startsWith('fc')) {
      return true;
    }
  }

  return false;
}

function isIpv4(host) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return false;
  }
  const parts = host.split('.').map(Number);
  return parts.every((part) => part >= 0 && part <= 255);
}

function stripTags(value) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function sanitizeTitle(value) {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length < 3) {
    return '';
  }
  return clean.slice(0, 200);
}

function titleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const slug = url.pathname.split('/').filter(Boolean).pop();
    if (!slug) {
      return url.host;
    }
    return decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rssResponse(xml, cacheStatus) {
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_MINUTES * 60}`,
      'X-Cache': cacheStatus,
    },
  });
}

function textResponse(text, status) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function homePage(origin) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>1rss Worker</title>
    <style>
      body { font-family: ui-sans-serif, sans-serif; margin: 2rem; line-height: 1.45; }
      code { background: #f2f2f2; padding: 0.15rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <h1>1rss Worker</h1>
    <p>Generate RSS 2.0 feed from an HTML page.</p>
    <p>Usage: <code>${origin}/feed?url=example.com</code></p>
  </body>
</html>`;
}
