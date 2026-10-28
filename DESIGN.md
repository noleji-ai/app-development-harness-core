# App Harness Decision Dashboard Design System

## 0. Research Log

- Embedded refs: shortlisted Sentry, Linear, and IBM Carbon; picked `taste-skill` execution discipline plus Sentry's dense status grammar because the surface is a technical decision cockpit.
- Lazyweb: 3 searches attempted, 0 screens viewed; the endpoint required a paid plan, so no external screenshots were copied or used.
- UI/UX database: `developer decision approval dashboard release readiness dark data dense` recommended an operations pattern, Fira Sans/Fira Code, visible focus, and 375/768/1024/1440 responsive checks.
- Generated design-reference images are omitted from this public source tree. The tokens, components and states below describe the existing dashboard; reference artwork is not runtime evidence.

## 1. Atmosphere & Identity

A quiet technical control room that turns an ambiguous app request into an auditable delivery run. The signature is a single luminous recommendation edge within deep aubergine tonal layers: the recommended choice is unmistakable without turning the whole dashboard into neon decoration.

## 2. Color

| Role | Token | Light | Dark | Usage |
|---|---|---|---|---|
| Surface primary | `--surface-primary` | `#F7F7FA` | `#150F23` | Page canvas |
| Surface secondary | `--surface-secondary` | `#FFFFFF` | `#1F1633` | Main panels |
| Surface elevated | `--surface-elevated` | `#F1EFF5` | `#281C3E` | Selected rows and dialogs |
| Text primary | `--text-primary` | `#20202B` | `#F7F5FA` | Headings and body |
| Text secondary | `--text-secondary` | `#676274` | `#B8AFC4` | Supporting copy |
| Border default | `--border-default` | `#D9D4E0` | `#3D3150` | Structural edges |
| Accent primary | `--accent-primary` | `#4F5D00` | `#C2EF4E` | Recommendation and focus |
| Accent hover | `--accent-hover` | `#3F4B00` | `#D3FF68` | Interactive hover |
| Status success | `--status-success` | `#2E6B38` | `#8FD49A` | Passed evidence |
| Status warning | `--status-warning` | `#9A4E00` | `#FFB287` | Blocking caution |
| Status error | `--status-error` | `#B4232F` | `#FA7F8D` | Failure and rejection |
| Status info | `--status-info` | `#534394` | `#A99BFF` | Active stage |

Color never acts alone. Every status also carries a text label or symbol. The lime accent appears only on recommendations, approval, and focus.

## 3. Typography

| Level | Size | Weight | Line height | Usage |
|---|---:|---:|---:|---|
| Display | 32px | 650 | 1.2 | Dashboard title |
| H1 | 24px | 650 | 1.25 | Decision title |
| H2 | 18px | 600 | 1.35 | Panel heading |
| H3 | 16px | 600 | 1.4 | Row title |
| Body | 16px | 400 | 1.55 | Default copy and mobile controls |
| Body small | 14px | 400 | 1.5 | Supporting text |
| Caption | 12px | 550 | 1.4 | Metadata |

- Primary: `ui-sans-serif, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`.
- Mono: `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`.
- Numbers use tabular figures. No remote font requests are allowed.

## 4. Spacing & Layout

- Base unit: 4px, tokens from 4px through 48px.
- Content width: fluid, capped at 1600px.
- Desktop: 232px stage rail plus a two-column decision workspace.
- Tablet at 768px: stage rail becomes a horizontal timeline; detail stacks below the ledger.
- Mobile at 375px: one column; primary decision actions remain sticky and at least 44px tall.
- Z-index scale: base 0, sticky 20, overlay 40, dialog 80.

## 5. Components

### Stage Rail
- Structure: navigation landmark with ordered stages and current-state text.
- States: complete, active, blocked, pending.
- Accessibility: current stage uses `aria-current="step"`; mobile keeps the label visible.

### Decision Row
- Structure: radio-like selection control, title, category, blocking state, revision.
- States: default, selected, focus, stale, empty.
- Accessibility: real button semantics and visible focus; status is never color-only.

### Comparison Matrix
- Structure: candidates as rows, criteria as columns, rationale below.
- States: recommended, selected, unavailable, blocked.
- Accessibility: semantic table on wide screens and labeled stacked groups on mobile.

### Decision Actions
- Structure: approve, reject, request revision, and comment controls.
- States: default, hover, active, focus, disabled, saving, conflict, success.
- Accessibility: 44px targets, status in an `aria-live` region, conflict preserves user input.

### Evidence List
- Structure: required checks with outcome, timestamp, and evidence reference.
- States: passed, failed, blocked, unverified, waived, empty.
- Accessibility: text and symbol pair for every state.

### Primitive Showcase
- The dashboard `?showcase=1` state renders all primitive states for 375, 768, and 1280px verification before product composition is accepted.

## 6. Motion & Interaction

- Micro feedback: 120ms ease-out for button press and focus arrival.
- Panel state change: 220ms ease-in-out using opacity and transform only.
- No automatic decorative motion. Saving and conflict feedback are the only animated states.
- `prefers-reduced-motion` disables transforms and transitions.

## 7. Depth & Surface

Strategy: tonal shift with sparse borders. Panels use progressively lighter aubergine surfaces; only the selected decision, sticky action bar, and modal receive a soft purple-tinted shadow. Glass blur is prohibited on routine cards.

## 8. Accessibility Constraints & Accepted Debt

- WCAG target: 2.2 AA, 4.5:1 body contrast, 3:1 large text and component boundaries.
- Full keyboard reachability, skip link, logical heading order, visible focus, reduced motion, 200% zoom, and natural Korean wrapping are mandatory.
- The read-only snapshot must preserve landmarks and decision history without JavaScript.

### Accepted Debt

None.
