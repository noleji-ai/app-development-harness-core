import type { DashboardDecision, DashboardViewModel } from "./view-model"

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return character
    }
  })
}

function decisionHtml(decision: DashboardDecision): string {
  const alternatives = decision.alternatives
    .map(
      (alternative) =>
        `<li><strong>${escapeHtml(alternative.label)}</strong><span>${escapeHtml(
          alternative.score,
        )}점</span><p>${escapeHtml(alternative.tradeoffs)}</p></li>`,
    )
    .join("")
  const evidence = decision.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
  return `<article class="decision">
    <header><div><p class="eyebrow">${escapeHtml(decision.category)} · revision ${escapeHtml(
      decision.revision,
    )}</p><h2>${escapeHtml(decision.recommendation)}</h2></div><span class="status">${escapeHtml(
      decision.statusLabel,
    )}</span></header>
    <p>${escapeHtml(decision.businessImpact)}</p>
    <h3>대안 비교</h3><ul class="alternatives">${alternatives}</ul>
    <h3>관련 증거</h3><ul>${evidence || "<li>연결된 증거 없음</li>"}</ul>
    ${decision.reason === null ? "" : `<h3>결정 이유</h3><p>${escapeHtml(decision.reason)}</p>`}
  </article>`
}

export function renderDashboardSnapshot(state: DashboardViewModel): string {
  const stages = state.stages
    .map(
      (stage) =>
        `<li><span>${escapeHtml(stage.label)}</span><small>${escapeHtml(
          stage.status,
        )} · ${escapeHtml(stage.decisionCount)}개</small></li>`,
    )
    .join("")
  const decisions = state.decisions.map(decisionHtml).join("")
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark"><title>App Harness 결정 스냅샷</title>
  <style>:root{color-scheme:light dark;--bg:#f7f7fa;--panel:#fff;--text:#20202b;--muted:#676274;--line:#d9d4e0;--accent:#4f5d00}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 ui-sans-serif,system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;overflow-wrap:anywhere}header,main{width:min(1120px,calc(100% - 32px));margin:auto}.hero{padding:48px 0 28px}.eyebrow,small{color:var(--muted);font-size:12px}h1{font-size:32px;line-height:1.2}nav,article{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}ol,.alternatives{display:grid;gap:8px;padding:0;list-style:none}nav ol{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}nav li,.alternatives li{padding:12px;background:color-mix(in srgb,var(--panel),var(--line) 24%);border-inline-start:3px solid var(--accent)}nav span,nav small{display:block}.decision header{width:auto;display:flex;gap:16px;justify-content:space-between}.status{white-space:nowrap;color:var(--accent);font-weight:650}.alternatives li{display:grid;grid-template-columns:1fr auto}.alternatives p{grid-column:1/-1;margin:4px 0}@media(prefers-color-scheme:dark){:root{--bg:#150f23;--panel:#1f1633;--text:#f7f5fa;--muted:#b8afc4;--line:#3d3150;--accent:#c2ef4e}}@media(max-width:480px){header,main{width:min(100% - 24px,1120px)}.hero{padding-top:28px}.decision header{display:block}.status{display:inline-block;margin-bottom:8px}}</style></head>
  <body><header class="hero"><p class="eyebrow">읽기 전용 스냅샷 · ${escapeHtml(
    state.generatedAt,
  )}</p><h1>의사결정 실행 현황</h1><p>차단 결정 ${escapeHtml(
    state.summary.blocking,
  )}개 · 승인 ${escapeHtml(state.summary.decided)}개 · 전체 ${escapeHtml(
    state.summary.total,
  )}개</p></header><main><nav aria-label="단계별 진행"><h2>진행 단계</h2><ol>${stages}</ol></nav>
  <section aria-labelledby="decisions-title"><h2 id="decisions-title">결정 원장</h2>${
    decisions || "<p>기록된 결정이 없습니다.</p>"
  }</section></main></body></html>`
}
