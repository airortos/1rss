# RSS Feed Generator Worker

Cloudflare Worker, который генерирует RSS 2.0 из любых веб-страниц без нативного RSS. Подписка через TT-RSS или любой RSS-агрегатор.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/airortos/1rss)

> Замените `airortos` на ваш GitHub username после создания репозитория.

После деплоя Cloudflare создаст D1 базу автоматически. Выполните в [D1 Console](https://dash.cloudflare.com) SQL из `schema.sql` для создания таблицы `feeds`:

```sql
CREATE TABLE IF NOT EXISTS feeds (
  url_key TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  rss_xml TEXT NOT NULL,
  item_count INTEGER,
  updated_at TEXT NOT NULL
);
```

## Использование

**Добавить фид в TT-RSS:**
- URL: `https://<ваш-worker>.workers.dev/feed?url=example.com`

**Примеры:**
- `https://rss-gen.xxx.workers.dev/feed?url=example.com`
- `https://rss-gen.xxx.workers.dev/feed?url=https://news.ycombinator.com`

## Ручной деплой через Dashboard

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create Worker
2. D1 → Create database `rss-gen-db`
3. Worker Settings → Add binding: `DB` → выберите `rss-gen-db`
4. D1 Console → выполните SQL из `schema.sql`
5. Quick Edit → вставьте код из `src/index.js`, Deploy

## Структура проекта

```
├── src/index.js    # Код Worker
├── schema.sql      # SQL для D1
├── wrangler.toml   # Конфиг Cloudflare
└── plan.md         # Подробный план разработки
```
