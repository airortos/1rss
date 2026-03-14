const CACHE_TTL_MINUTES = 30;
const MAX_ITEMS = 25;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1500000;
const SELECTOR_MAX_LENGTH = 80;

// Free-tier safety guards: keep subrequests and payload size predictable.
const MAX_ENRICH_ITEMS = 6;
const ARTICLE_TIMEOUT_MS = 7000;
const MAX_ARTICLE_BYTES = 700000;
const MAX_DESCRIPTION_CHARS = 1800;
const DEFAULT_TTRSS_BASE = 'https://bakar.no/rss';

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (request.method === 'GET' && requestUrl.pathname === '/') {
      return new Response(homePage(requestUrl.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/bookmarklet') {
      const ttrssBaseRaw = requestUrl.searchParams.get('ttrss') || (env && env.TTRSS_BASE) || DEFAULT_TTRSS_BASE;
      const normalizedTtrss = normalizeTtrssBase(ttrssBaseRaw);
      if (!normalizedTtrss.ok) {
        return textResponse(normalizedTtrss.error, 400);
      }

      const bookmarklet = buildBookmarklet(requestUrl.origin, normalizedTtrss.base);
      return new Response(bookmarklet, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/subscribe') {
      return handleSubscribe(requestUrl, env);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/feed') {
      const rawTargetUrl = requestUrl.searchParams.get('url');
      const rawSelector = requestUrl.searchParams.get('selector');
      if (!rawTargetUrl) {
        return textResponse(
          'Query parameter "url" is required. Example: /feed?url=https://example.com',
          400
        );
      }
      try {
        return await handleFeed(rawTargetUrl, rawSelector, env);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return textResponse(message, 502);
      }
    }

    return textResponse('Not Found', 404);
  },
};

async function handleFeed(rawTargetUrl, rawSelector, env) {
  const normalized = normalizeTargetUrl(rawTargetUrl);
  if (!normalized.ok) {
    return textResponse(normalized.error, 400);
  }

  const normalizedSelector = normalizeSelector(rawSelector);
  if (!normalizedSelector.ok) {
    return textResponse(normalizedSelector.error, 400);
  }

  const targetUrl = normalized.url;
  const selector = normalizedSelector.selector;
  const cacheKeySource = selector ? `${targetUrl}::${selector}` : targetUrl;
  const urlKey = await sha256(cacheKeySource);
  const db = env && env.DB ? env.DB : null;

  if (db) {
    await ensureSchema(db);
    const cached = await getCachedFeed(db, urlKey, CACHE_TTL_MINUTES);
    if (cached) {
      return rssResponse(cached.rss_xml, 'HIT');
    }
  }

  const html = await fetchHtml(targetUrl);
  const links = extractLinksFromHtml(html, targetUrl, MAX_ITEMS, selector);
  const enrichedLinks = await enrichItemsWithArticleText(links);
  const rss = buildRss(targetUrl, enrichedLinks);

  if (db) {
    await upsertFeed(db, {
      urlKey,
      targetUrl,
      rssXml: rss,
      itemCount: enrichedLinks.length,
      updatedAt: new Date().toISOString(),
    });
  }

  return rssResponse(rss, 'MISS');
}

function handleSubscribe(requestUrl, env) {
  const rawTargetUrl = requestUrl.searchParams.get('url');
  const rawSelector = requestUrl.searchParams.get('selector');
  const rawTtrssBase = requestUrl.searchParams.get('ttrss') || (env && env.TTRSS_BASE) || DEFAULT_TTRSS_BASE;

  if (!rawTargetUrl) {
    return textResponse('Query parameter "url" is required for /subscribe', 400);
  }

  const normalizedTarget = normalizeTargetUrl(rawTargetUrl);
  if (!normalizedTarget.ok) {
    return textResponse(normalizedTarget.error, 400);
  }

  const normalizedSelector = normalizeSelector(rawSelector);
  if (!normalizedSelector.ok) {
    return textResponse(normalizedSelector.error, 400);
  }

  const normalizedTtrss = normalizeTtrssBase(rawTtrssBase);
  if (!normalizedTtrss.ok) {
    return textResponse(normalizedTtrss.error, 400);
  }

  const feedUrl = new URL('/feed', requestUrl.origin);
  feedUrl.searchParams.set('url', normalizedTarget.url);
  if (normalizedSelector.selector) {
    feedUrl.searchParams.set('selector', normalizedSelector.selector);
  }

  const subscribeUrl = new URL('public.php', `${normalizedTtrss.base}/`);
  subscribeUrl.searchParams.set('op', 'subscribe');
  subscribeUrl.searchParams.set('feed_url', feedUrl.toString());

  return Response.redirect(subscribeUrl.toString(), 302);
}

function buildBookmarklet(workerOrigin, ttrssBase) {
  const workerValue = JSON.stringify(workerOrigin);
  const ttrssValue = JSON.stringify(ttrssBase);

  return `javascript:(function(){var worker=${workerValue};var ttrss=${ttrssValue};var url=worker+'/subscribe?url='+encodeURIComponent(window.location.href)+'&ttrss='+encodeURIComponent(ttrss);if(confirm('Subscribe generated feed in Tiny Tiny RSS?')){window.location.href=url;}})();`;
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

function extractLinksFromHtml(html, targetUrl, maxItems, selector) {
  const scopedHtml = buildHtmlScope(html, selector);
  let items = collectLinksFromFragment(scopedHtml, targetUrl, maxItems);

  if (selector && scopedHtml !== html && items.length === 0) {
    items = collectLinksFromFragment(html, targetUrl, maxItems);
  }

  if (items.length === 0) {
    const targetHost = new URL(targetUrl).host;
    items.push({
      title: `No article links were detected on ${targetHost}`,
      link: targetUrl,
      guid: `${targetUrl}#placeholder`,
      description: `No article links were detected on ${targetHost}`,
      pubDate: new Date().toUTCString(),
    });
  }

  return items;
}

function collectLinksFromFragment(htmlFragment, targetUrl, maxItems) {
  const targetHost = new URL(targetUrl).host;
  const seen = new Set();
  const items = [];
  const anchorRegex =
    /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRegex.exec(htmlFragment)) !== null) {
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
      description: '',
      imageUrl: '',
      pubDate: new Date().toUTCString(),
    });

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

function buildHtmlScope(html, selector) {
  if (!selector || selector === 'a') {
    return html;
  }

  const container = selector.replace(/\s+a$/i, '').trim();
  const fragments =
    container.startsWith('.')
      ? extractContainersByClass(html, container.slice(1))
      : container.startsWith('#')
        ? extractContainersById(html, container.slice(1))
        : extractContainersByTag(html, container.toLowerCase());

  if (fragments.length === 0) {
    return html;
  }

  return fragments.join('\n');
}

function extractContainersByTag(html, tagName) {
  const safeTag = escapeRegExp(tagName);
  const regex = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'gi');
  const fragments = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    fragments.push(match[1]);
  }

  return fragments;
}

function extractContainersByClass(html, className) {
  const regex = /<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const fragments = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[2] || '';
    const classValue = readAttribute(attrs, 'class');
    if (!classValue) {
      continue;
    }
    const classes = classValue.split(/\s+/).filter(Boolean);
    if (classes.includes(className)) {
      fragments.push(match[3]);
    }
  }

  return fragments;
}

function extractContainersById(html, idValue) {
  const regex = /<([a-zA-Z][a-zA-Z0-9:-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const fragments = [];
  let match;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[2] || '';
    const id = readAttribute(attrs, 'id');
    if (id === idValue) {
      fragments.push(match[3]);
    }
  }

  return fragments;
}

async function enrichItemsWithArticleText(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return items;
  }

  const enriched = items.map((item) => ({ ...item }));
  const limit = Math.min(MAX_ENRICH_ITEMS, enriched.length);
  const tasks = [];

  for (let i = 0; i < limit; i += 1) {
    const item = enriched[i];
    if (!item || !item.link || String(item.guid || '').endsWith('#placeholder')) {
      continue;
    }

    tasks.push(
      enrichSingleItem(item).then((updated) => {
        enriched[i] = updated;
      })
    );
  }

  await Promise.all(tasks);
  return enriched;
}

async function enrichSingleItem(item) {
  try {
    const details = await fetchArticleDetails(item.link);
    if (!details || !details.description) {
      return item;
    }

    return {
      ...item,
      title: details.title || item.title,
      description: details.description,
      imageUrl: details.imageUrl || item.imageUrl || '',
    };
  } catch {
    return item;
  }
}
async function fetchArticleDetails(articleUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), ARTICLE_TIMEOUT_MS);

  try {
    const response = await fetch(articleUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': '1rss-worker/1.0 (+https://workers.dev)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
    });

    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    const isHtml =
      contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
    if (!isHtml) {
      return null;
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_ARTICLE_BYTES) {
      return null;
    }

    const html = new TextDecoder('utf-8').decode(buffer);
    return extractArticleSummary(html, articleUrl);
  } finally {
    clearTimeout(timeout);
  }
}

function extractArticleSummary(html, articleUrl) {
  const ogTitle = extractMetaContent(html, 'property', 'og:title');
  const twitterTitle = extractMetaContent(html, 'name', 'twitter:title');
  const pageTitle = stripTags(extractTagContent(html, 'title'));
  const title = sanitizeTitle(decodeHtmlEntities(ogTitle || twitterTitle || pageTitle || ''));

  const metaDescription = decodeHtmlEntities(
    extractMetaContent(html, 'name', 'description') ||
      extractMetaContent(html, 'property', 'og:description') ||
      extractMetaContent(html, 'name', 'twitter:description')
  );

  const rawImage =
    extractMetaContent(html, 'property', 'og:image') ||
    extractMetaContent(html, 'name', 'twitter:image') ||
    extractMetaContent(html, 'property', 'twitter:image');
  const imageUrl = normalizeImageUrl(rawImage, articleUrl);

  const cleanHtml = stripNonContentTags(html);
  const articleScope = firstNonEmpty(
    firstTagInnerHtml(cleanHtml, 'article'),
    firstTagInnerHtml(cleanHtml, 'main'),
    cleanHtml
  );

  const paragraphs = [];
  const paragraphRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = paragraphRegex.exec(articleScope)) !== null) {
    const text = stripTags(match[1] || '');
    if (text.length < 40) {
      continue;
    }
    paragraphs.push(text);

    if (paragraphs.join(' ').length >= MAX_DESCRIPTION_CHARS * 2) {
      break;
    }
  }

  let description = paragraphs.join('\n\n').trim();
  if (!description) {
    description = sanitizeDescription(metaDescription);
  } else {
    description = sanitizeDescription(description);
  }

  if (!description) {
    return null;
  }

  return {
    title,
    description,
    imageUrl,
  };
}
function stripNonContentTags(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
}

function extractMetaContent(html, key, value) {
  const safeValue = escapeRegExp(value);
  const regex = new RegExp(
    `<meta\\b[^>]*${key}\\s*=\\s*(?:"${safeValue}"|'${safeValue}')[^>]*>`,
    'i'
  );
  const match = html.match(regex);
  if (!match) {
    return '';
  }

  return readAttribute(match[0], 'content');
}

function extractTagContent(html, tagName) {
  const safeTag = escapeRegExp(tagName);
  const regex = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'i');
  const match = html.match(regex);
  return match ? match[1] : '';
}

function firstTagInnerHtml(html, tagName) {
  const safeTag = escapeRegExp(tagName);
  const regex = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'i');
  const match = html.match(regex);
  return match ? match[1] : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value && String(value).trim()) {
      return String(value);
    }
  }
  return '';
}

function sanitizeDescription(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }

  if (clean.length <= MAX_DESCRIPTION_CHARS) {
    return clean;
  }

  return `${clean.slice(0, MAX_DESCRIPTION_CHARS).trim()}...`;
}

function normalizeImageUrl(rawValue, baseUrl) {
  const input = String(rawValue || '').trim();
  if (!input) {
    return '';
  }

  try {
    const url = new URL(input, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '';
    }
    if (isLocalOrPrivateHost(url.hostname.toLowerCase())) {
      return '';
    }

    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function guessImageMime(imageUrl) {
  const path = new URL(imageUrl).pathname.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}
function readAttribute(attrs, name) {
  const attrRegex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const match = attrs.match(attrRegex);
  if (!match) {
    return '';
  }
  return (match[1] || match[2] || match[3] || '').trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  if (/(^\/amp$|\/amp\/)/i.test(path)) {
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
      const description = sanitizeDescription(item.description || item.title || '');
      const safeImageUrl = item.imageUrl ? escapeXml(item.imageUrl) : '';
      const enclosureLine = item.imageUrl
        ? `      <enclosure url="${safeImageUrl}" type="${guessImageMime(item.imageUrl)}" />`
        : '';
      const mediaLine = item.imageUrl ? `      <media:thumbnail url="${safeImageUrl}" />` : '';

      return [
        '    <item>',
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(item.link)}</link>`,
        `      <guid>${escapeXml(item.guid)}</guid>`,
        `      <description>${escapeXml(description)}</description>`,
        `      <pubDate>${escapeXml(item.pubDate)}</pubDate>`,
        enclosureLine,
        mediaLine,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">',
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

function normalizeSelector(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, selector: '' };
  }

  const selector = String(rawValue).trim().replace(/\s+/g, ' ');
  if (!selector) {
    return { ok: true, selector: '' };
  }

  if (selector.length > SELECTOR_MAX_LENGTH) {
    return {
      ok: false,
      error: `Query parameter "selector" is too long (max ${SELECTOR_MAX_LENGTH} chars)`,
    };
  }

  if (!/^[A-Za-z0-9._#\-\s]+$/.test(selector)) {
    return {
      ok: false,
      error: 'Unsupported selector characters. Use letters, digits, ., #, -, and spaces only',
    };
  }

  if (selector === 'a') {
    return { ok: true, selector };
  }

  if (!/^([A-Za-z][A-Za-z0-9-]*|[.#][A-Za-z0-9_-]+)\s+a$/.test(selector)) {
    return {
      ok: false,
      error: 'Unsupported selector. Examples: a, main a, article a, .content a, #main a',
    };
  }

  return { ok: true, selector };
}

function normalizeTtrssBase(rawValue) {
  let input = String(rawValue || '').trim();
  if (!input) {
    return { ok: false, error: 'TT-RSS base URL is required' };
  }

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  let url;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'Invalid TT-RSS base URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'TT-RSS base URL must be http:// or https://' };
  }

  if (isLocalOrPrivateHost(url.hostname.toLowerCase())) {
    return { ok: false, error: 'Local/private TT-RSS URLs are not allowed' };
  }

  url.hash = '';
  url.search = '';

  let pathname = url.pathname || '';
  pathname = pathname.replace(/\/+$/, '');
  if (pathname.toLowerCase().endsWith('/public.php')) {
    pathname = pathname.slice(0, -'/public.php'.length);
  }
  url.pathname = pathname || '/';

  const base = url.toString().replace(/\/+$/, '');
  return { ok: true, base };
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
    if (
      host === '::1' ||
      host.startsWith('fe80:') ||
      host.startsWith('fd') ||
      host.startsWith('fc')
    ) {
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
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function sanitizeTitle(value) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
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
    <p>Generate RSS 2.0 feed from an HTML page with article text excerpts.</p>
    <p>Usage: <code>${origin}/feed?url=example.com</code></p>
    <p>Optional selector: <code>${origin}/feed?url=example.com&selector=main%20a</code></p>
    <p>Chrome bookmarklet source: <code>${origin}/bookmarklet</code></p>
    <p>One-click subscribe: <code>${origin}/subscribe?url=https://example.com</code></p>
  </body>
</html>`;
}









