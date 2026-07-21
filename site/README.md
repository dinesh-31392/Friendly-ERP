# Friendly ERP — marketing site & knowledge base

Static, dependency-free HTML. No build step: what's here is what you deploy.

```
site/
  index.html        marketing landing page
  docs.html         knowledge base
  api.html          API reference
  assets/site.css   shared styles (one file, no framework)
  icons/            favicon + touch icons (copied from the app's public/icons)
```

## Where it goes

The CRM app already occupies `/` on its own host. Keep them separate:

| Host | Serves |
| --- | --- |
| `www.yourdomain.com` | this `site/` folder |
| `app.yourdomain.com` | the CRM (`dist/`) |

### Point the site at your CRM — the one line you must change

Every **Log in** and **Start free trial** link on the site reads a single
constant. Open `assets/config.js` and set it:

```js
window.APP_URL = 'https://app.yourdomain.com';   // <- change this
```

That's the whole job. Every link on every page (8 of them) rebuilds from it, so
there is nothing to find-and-replace. The `href` written in the HTML is a real
fallback, so links still work if the script fails to load — which is also why
the placeholder in the HTML is a valid URL rather than `#`.

Links are marked with `data-app`, and the attribute value is the path:

```html
<a data-app="/login" href="https://app.example.com/login">Log in</a>
```

### nginx

```nginx
server {
    listen 80;
    server_name www.yourdomain.com yourdomain.com;

    root /usr/share/nginx/site;
    index index.html;

    # Static marketing pages — no SPA fallback. A missing page should 404,
    # not silently return the homepage.
    location / {
        try_files $uri $uri.html $uri/ =404;
    }

    location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
    location /icons/  { add_header Cache-Control "public, max-age=31536000, immutable"; }

    gzip on;
    gzip_types text/html text/css image/svg+xml;
}
```

`try_files $uri $uri.html` means `/docs` works as well as `/docs.html`.

## Editing

Copy lives directly in the HTML. There is no CMS and no templating — for three
pages that is a feature, not a gap. Brand colours are CSS variables at the top of
`assets/site.css`; changing `--indigo` / `--violet` re-themes everything.

To re-brand the icons, edit `BRAND` in `scripts/generate-icons.mjs`, run
`npm run icons`, then copy `public/icons/*.png` here.

## The rule for this site

**Every claim on these pages is backed by code that actually runs.**

The content was written against a feature audit of the real source, and claims
the code could not support were removed rather than softened. Specifically, the
site does **not** claim:

- Any working third-party integration (Facebook / Google Ads / property portals /
  Zapier / Razorpay / Google Calendar). None of them call an external API today.
- AI content generation. AI Studio is template-based, not a model.
- That the CRM sends WhatsApp or email. It opens the app on your device with the
  message prefilled; a person still presses send.
- Cloud telephony. Only `tel:` dialling works.
- Payment collection. The CRM records instalments; it does not take money.

If any of those ship for real, update the audit first, then the copy — in that
order.
