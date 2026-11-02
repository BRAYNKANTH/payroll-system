# Design system

Everything lives in `public/css/app.css`. Pages build HTML with the classes below; avoid inline `style=`.

## Tokens (`:root`)

| Group | Tokens | Use |
|---|---|---|
| Colour | `--primary` (deep green), `--accent` (terracotta), `--success`, `--warning`, `--danger`, `--info` and their `-soft` tints | One primary and one accent. Status colours only for status. |
| Surface | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--border`, `--border-strong` | Page, card, table header, input fill, dividers |
| Text | `--text`, `--text-2`, `--text-3` | Body, secondary, hints |
| Spacing | `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32 | All gaps, padding and margins |
| Shape | `--radius` 8, `--radius-sm` 5 | Cards and inputs, badges and chips |
| Elevation | `--shadow` (cards), `--shadow-lg` (menus, drawers, hover) | Never more than these two |
| Type | `--font` IBM Plex Sans, `--font-display` Newsreader, `--mono` IBM Plex Mono | Body, headings and big numbers, IDs and account numbers |

Dark mode only redefines the tokens (`:root[data-theme="dark"]`). Do not hard-code hex values in a page.

## Cards

```html
<div class="card">
  <div class="card-head"><div><h3>Title</h3><div class="sub">Optional one-line description</div></div> [actions] </div>
  <div class="card-body">…padded content…</div>          <!-- 20px padding -->
  <div class="card-body flush">…table…</div>             <!-- no padding; table aligns to the 20px edge -->
  <div class="card-foot">…buttons…</div>                 <!-- tinted strip under the content -->
</div>
```

| Card | Use when |
|---|---|
| `card kpi` | A headline figure: label with a tinted icon (`blue`, `green`, `amber`, `red`), a large value, one line of context. The top edge takes the icon's colour. A `red` card shows its value in red. Use `compact()` for the value and put the exact amount in the foot. |
| `card` + `card-head` | A chart, table or form section. The head always has a divider. |
| `alert` (`info`, `warn`, `ok`, `err`) | A message above the content, not inside a card. |

## Layout

- `.content` holds the page. It is 1480px wide at most and has 24px of padding (28px and 32px from 1280px wide).
- `.page-head`: `h1`, one line of description, and `.actions` on the right.
- `.grid` with `.kpis` (auto-fit, 180px minimum), `.two` (2:1), `.halves`, `.three`; `.stack` for vertical rhythm. The gap is `--sp-4`.
- Utilities: `mb-3`, `mb-4`, `mt-4`, `text-sm`, `fw-400`, `stat-lg`, `sub-head`.

## Do and don't

| Do | Don't |
|---|---|
| Use `--sp-*` and the utility classes | Add `style="margin:…"` to a template |
| Put the exact money amount in a foot or a table | Wrap a long figure inside a KPI card |
| Keep a person's name on one line in tables | Let the first column collapse |
| Use status colours for status only | Colour decoration with green, amber or red |

## Checks before shipping a screen

1. Phone width (375px): no sideways scroll of the page; wide tables scroll inside their own card.
2. Dark mode: text and borders stay readable.
3. Keyboard: every control reachable, with a visible focus ring.
4. Touch targets are at least 40px on phones.
