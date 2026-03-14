# RSS Feed Generator Worker

Cloudflare Worker, который генерирует RSS 2.0 из веб-страниц без нативного RSS.
Подписка через TT-RSS или любой RSS-агрегатор.

Каждый `item` включает:
- `title`
- `link`
- `guid`
- `pubDate`
- `description` (текстовый фрагмент статьи)
- `enclosure`/`media:thumbnail` (URL 1 картинки из `og:image`/`twitter:image`)

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/airortos/1rss)

## Использование

Базовый URL:
- `https://<your-worker>.workers.dev/feed?url=example.com`

Селектор (опционально):
- `https://<your-worker>.workers.dev/feed?url=example.com&selector=main%20a`

Поддерживаемые селекторы:
- `a`
- `main a`
- `article a`
- `.content a`
- `#main a`

## Bookmarklet для Chrome (подписка в Tiny Tiny RSS)

1. Откройте:
- `https://<your-worker>.workers.dev/bookmarklet`

2. Скопируйте строку `javascript:...`.

3. Создайте закладку в Chrome и вставьте этот код в поле URL.

4. На любой странице нажмите закладку.

Что произойдет:
- bookmarklet откроет `.../subscribe?url=<текущая_страница>&scope=site`
- Worker сделает редирект в TT-RSS на:
`/public.php?op=subscribe&feed_url=<наш_feed_url>`
- по умолчанию `scope=site` обрезает цель до корня сайта (например `https://site.com/`)

Если нужно подписаться на конкретную страницу, а не на сайт:
- `.../subscribe?url=<текущая_страница>&scope=page`

По умолчанию TT-RSS база:
- `https://bakar.no/rss`

Кастомный TT-RSS (опционально):
- `https://<your-worker>.workers.dev/bookmarklet?ttrss=https://example.com/rss`

## Ограничения под бесплатный Cloudflare

Чтобы не выходить за free-tier лимиты, Worker ограничивает enrichment:
- максимум `6` дополнительных запросов к страницам статей на один `/feed`-запрос
- таймаут статьи: `7s`
- лимит размера HTML статьи: `700 KB`
- лимит длины `description`: `1800` символов
- картинка не скачивается бинарно: сохраняем только URL (без проксирования)

## D1 схема

```sql
CREATE TABLE IF NOT EXISTS feeds (
  url_key TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  rss_xml TEXT NOT NULL,
  item_count INTEGER,
  updated_at TEXT NOT NULL
);
```

## Структура проекта

```text
1rss/
├── plan.md
├── README.md
├── wrangler.toml
├── schema.sql
├── .gitignore
└── src/
    └── index.js
```
