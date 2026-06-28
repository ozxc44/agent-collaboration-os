# dashboard/lib

Shared browser-global utilities extracted from the dashboard pages. Each file is
a plain classic script (no ES modules) that populates `window.CodexUtils`. Pages
include them before their main inline script:

```html
<script src="lib/format.js"></script>
<script src="lib/api.js"></script>
<script src="lib/markdown.js"></script>
```

Load order matters: `format.js` must load before `markdown.js` (the renderer
calls `CodexUtils.escapeHtml`). `api.js` is independent.

## format.js

- `escapeHtml(value)` — escape `& < > " '`; null/undefined render as `""`.
- `escapeAttr(value)` — `escapeHtml` plus backtick escaping, for attributes.
- `formatBytes(bytes)` — `B`/`KB`/`MB`/`GB`; empty/NaN → `""`.
- `formatDate(iso, lang?)` — relative time; `lang="en"` (default) or `"zh"`.
- `shortId(id)` — first 8 chars, coerced via `String(id)`.
- `visibilityLabel(value)` — `Public` / `Private` / fallback.

## api.js

- `normalizeBaseUrl(value)` — trim and strip trailing slashes.
- `authHeaders(jwt)` — JSON + optional `Authorization: Bearer`.
- `api(baseUrl, jwt, method, path, body?)` — fetch + JSON parse + error carrying
  `.status` / `.payload`.
- `collection(payload)` — coerce bare array or `{ data: [...] }` to an array.

## markdown.js

- `SAFE_LINK_SCHEMES`, `SAFE_IMG_SCHEMES` — internal scheme allowlists.
- `isSafeLinkUrl(url)` / `isSafeImgSrc(url)` — allowlist + relative-path check.
- `inlineMarkdown(text)` — inline marks; escapes first.
- `simpleMarkdown(text)` — block-aware renderer used for README/file previews.
