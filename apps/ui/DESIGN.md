# canette UI design system

The UI implements the **Canette Dashboard v4** redesign (Claude Design project:
[Canette Dashboard v4](https://claude.ai/design/p/50d48d8f-5499-4ea7-90c9-d01cbbc02d09?file=Canette%20Dashboard%20v4.dc.html)).
The mockup is the visual reference; this document is the implementation contract.
When they disagree, this document wins.

Deliberate deviations from the mockup: Geist / Geist Mono instead of IBM Plex Mono,
and the current route hierarchy (dashboard → project → app pages) instead of the
mockup's flattened "Your apps" overview and edit dialogs.

---

## Tokens

All colors are CSS variables defined in `src/app/globals.css` (`:root` = light,
`.dark` = dark) and exposed as Tailwind utilities via `@theme inline`.
**Never use raw Tailwind palette colors** (`amber-600`, `green-500`, …) for
semantic states — always the tokens below, so both themes stay correct and the
palette can change in one place.

### Surfaces

| Token | Utility | Use |
|---|---|---|
| `--background` | `bg-background` | page background |
| `--surface` | `bg-surface` | sidebar, top header |
| `--card` | `bg-card` | panels/cards |
| `--panel-soft` | `bg-panel-soft` | inset rows inside cards |
| `--muted` | `bg-muted` | hovers, icon squares, chips |
| `--popover` | `bg-popover` | menus, dialogs, raised segments |
| `--field` | `bg-field` | inputs, outline buttons |

### Lines and text

| Token | Utility | Use |
|---|---|---|
| `--border` | `border-border` | default 1px lines |
| `--border-strong` | `border-border-strong` | card hover borders |
| `--input` | `border-input` | field borders |
| `--foreground` | `text-foreground` | primary text |
| `--muted-foreground` | `text-muted-foreground` | secondary text |
| `--tertiary` | `text-tertiary` | metadata, hints, mono sublines |

### Accent (amber)

`--primary` #ffc53d with `--primary-foreground` (dark text on amber) and
`--primary-hover`. Scale: `accent-soft` (soft fills: active nav, menu-item
hover), `accent-ring` (focus halos), `accent-line` (accent inset borders),
`accent-text` (amber-tinted text/links, readable in both themes).

### Status scales

Four states, each in three tiers — solid dot (`success`), readable text
(`success-text`), soft fill (`success-soft`); same for `warning`,
`destructive` (+ `destructive-hover`, `destructive-line`, `warning-line`),
and `info`. Deployment-status mapping lives in ONE place:
`statusVariant()` in `src/components/ui/status-badge.tsx` — never re-map
statuses to colors ad hoc.

---

## Shared components (`src/components/ui/`)

| Component | Use for |
|---|---|
| `StatusBadge` | soft chip with dot — app/deployment status in headers and cards |
| `StatusLabel` | bare dot + colored text — compact list rows |
| `StatusDot` | ringed dot only — deployment-history row markers |
| `Terminal` | ALL log/manifest/YAML output. Always dark (`#111113`) in both themes; dim metadata text is `#777b84` |
| `SegmentedControl` | single-select pill pickers (Source, Type, log modes). Never re-implement with bordered buttons |
| `Badge` | non-status chips only (scan results, counts). Status goes through `StatusBadge` |

Radix primitives (dialog, dropdown, select, tabs, collapsible, checkbox) remain
the base for interactive components per CLAUDE.md.

## Patterns

- **Cards**: flat — 1px `border-border`, `rounded-lg`, no shadow; hover
  `border-border-strong` when clickable. Inset lists inside cards:
  `ring-1 ring-border ring-inset rounded-md` with `bg-panel-soft` rows.
- **Identity squares**: apps/teams/projects get a small rounded square
  (`bg-muted` + mono initials, or a hash-picked color for teams/projects —
  see `teamColor`/`projectColor`).
- **Tabs**: 2px `border-primary` underline on the active tab (`TabNavigation`).
- **Focus**: fields get `focus-visible:border-primary` + `ring-2 ring-accent-ring`;
  buttons `ring-accent-ring` with offset.
- **Warning/error notes**: soft fill + inset ring, e.g.
  `bg-warning-soft ring-1 ring-inset ring-warning-line text-warning-text`.
- **Mono**: `font-mono` (Geist Mono) for identifiers — app names, slugs, shas,
  URLs, env keys, schedules — not for prose.
- **Settings pages**: card sections with a sticky left anchor rail
  (see app settings `SectionNav`); danger zones use
  `ring-1 ring-inset ring-destructive-line` + `text-destructive-text`.

## Not yet implemented (mockup-only, needs backend)

Metrics tab (traffic chart, stat tiles), repo auto-detection preview in the
new-app flow, build-pipeline phase panel, ⌘K search. Don't build these as
UI-only stubs.
