const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? ""
window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)

let dashboardState = null
let selectedDecisionId = null

function byId(id) {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`Missing dashboard element: ${id}`)
  return node
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function setStatus(message, kind = "") {
  const live = byId("live-status")
  live.textContent = message
  live.dataset.kind = kind
}

function centerCurrentStage() {
  const list = byId("stage-list")
  const current = list.querySelector('[aria-current="step"]')
  const rail = list.parentElement
  if (!(current instanceof HTMLElement) || rail === null) return
  rail.scrollLeft = Math.max(0, current.offsetLeft - (rail.clientWidth - current.clientWidth) / 2)
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers)
  headers.set("authorization", `Bearer ${token}`)
  const response = await fetch(path, { ...options, headers })
  const body = await response.json()
  return { response, body }
}

function renderStages(stages) {
  const list = byId("stage-list")
  list.replaceChildren()
  const current = stages.find((stage) => stage.status === "blocked" || stage.status === "active")
  let currentItem = null
  for (const stage of stages) {
    const item = element("li", `stage-item is-${stage.status}`)
    if (current?.id === stage.id) {
      item.setAttribute("aria-current", "step")
      currentItem = item
    }
    item.append(element("span", "stage-marker"))
    const copy = element("div")
    copy.append(element("strong", "", stage.label))
    copy.append(element("small", "", `${stage.status} · 결정 ${stage.decisionCount}개`))
    item.append(copy)
    list.append(item)
  }
  byId("run-count").textContent =
    `${stages.filter((stage) => stage.status === "complete").length} / ${stages.length}`
  if (currentItem !== null) centerCurrentStage()
}

function statusClass(status) {
  return `status-pill is-${status}`
}

function renderDecisionList(decisions) {
  const list = byId("decision-list")
  list.replaceChildren()
  if (decisions.length === 0) {
    list.append(element("p", "empty-copy", "기록된 결정이 없습니다."))
    return
  }
  for (const decision of decisions) {
    const button = element("button", "decision-row")
    button.type = "button"
    button.dataset.decisionId = decision.id
    button.setAttribute("aria-pressed", String(decision.id === selectedDecisionId))
    if (decision.id === selectedDecisionId) button.classList.add("is-selected")
    const heading = element("span", "decision-row-heading")
    heading.append(element("strong", "", decision.recommendation))
    heading.append(element("small", "", `${decision.category} · r${decision.revision}`))
    button.append(heading)
    button.append(element("span", statusClass(decision.status), decision.statusLabel))
    button.addEventListener("click", () => {
      selectedDecisionId = decision.id
      renderDecisionList(decisions)
      renderDetail(decision)
    })
    list.append(button)
  }
}

function highestScoreId(alternatives) {
  let best = alternatives[0]
  for (const alternative of alternatives.slice(1)) {
    if (best === undefined || alternative.score > best.score) best = alternative
  }
  return best?.id ?? ""
}

function renderAlternatives(decision) {
  const body = byId("alternatives")
  body.replaceChildren()
  const initial = decision.selected ?? highestScoreId(decision.alternatives)
  for (const alternative of decision.alternatives) {
    const row = document.createElement("tr")
    if (alternative.id === initial) row.className = "is-recommended"
    const choice = document.createElement("td")
    choice.dataset.label = "선택"
    const input = document.createElement("input")
    input.type = "radio"
    input.name = "alternative"
    input.value = alternative.id
    input.checked = alternative.id === initial
    input.setAttribute("aria-label", `${alternative.label} 선택`)
    choice.append(input)
    const label = element("td", "", alternative.label)
    label.dataset.label = "방향"
    const score = element("td", "score-cell", `${alternative.score}`)
    score.dataset.label = "점수"
    const tradeoffs = element("td", "", alternative.tradeoffs)
    tradeoffs.dataset.label = "트레이드오프"
    row.append(choice, label, score, tradeoffs)
    body.append(row)
  }
}

function renderEvidence(evidence) {
  const list = byId("evidence-list")
  list.replaceChildren()
  for (const reference of evidence) {
    const item = element("li")
    item.append(element("span", "evidence-mark", "근거"), element("code", "", reference))
    list.append(item)
  }
  if (evidence.length === 0) list.append(element("li", "empty-copy", "연결된 증거가 없습니다."))
}

function renderDetail(decision, preservedReason = "") {
  byId("empty-detail").hidden = true
  byId("detail-content").hidden = false
  byId("detail-meta").textContent =
    `${decision.stage} / ${decision.category} / revision ${decision.revision}`
  byId("detail-recommendation").textContent = decision.recommendation
  byId("detail-impact").textContent = decision.businessImpact || "기록된 사업 영향이 없습니다."
  const status = byId("detail-status")
  status.className = statusClass(decision.status)
  status.textContent = decision.statusLabel
  byId("decision-reason").value = preservedReason || decision.reason || ""
  renderAlternatives(decision)
  renderEvidence(decision.evidence)
}

function renderShowcase(enabled) {
  const showcase = byId("showcase")
  showcase.hidden = !enabled
  if (!enabled) return
  const states = byId("showcase-states")
  states.replaceChildren()
  for (const [status, label] of [
    ["pending", "결정 대기"],
    ["approved", "승인됨"],
    ["rejected", "반려됨"],
    ["revision_requested", "수정 요청"],
  ])
    states.append(element("span", statusClass(status), label))
}

function render(state, preservedReason = "") {
  dashboardState = state
  byId("summary-total").textContent = `${state.summary.total}`
  byId("summary-blocking").textContent = `${state.summary.blocking}`
  byId("summary-decided").textContent = `${state.summary.decided}`
  byId("generated-at").textContent =
    `업데이트 ${new Date(state.generatedAt).toLocaleString("ko-KR")}`
  byId("pending-count").textContent = `대기 ${state.summary.blocking}`
  renderStages(state.stages)
  renderShowcase(state.showcase)
  const selected =
    state.decisions.find((decision) => decision.id === selectedDecisionId) ??
    state.decisions.find((decision) => decision.blocking && decision.status !== "approved") ??
    state.decisions[0]
  selectedDecisionId = selected?.id ?? null
  renderDecisionList(state.decisions)
  if (selected) renderDetail(selected, preservedReason)
}

async function loadState(preservedReason = "") {
  const showcase = new URLSearchParams(window.location.search).get("showcase") === "1"
  const { response, body } = await api(`/api/state${showcase ? "?showcase=1" : ""}`)
  if (!response.ok) throw new Error(body.error ?? "state_load_failed")
  render(body, preservedReason)
}

async function saveDecision(action) {
  if (dashboardState === null) return
  const decision = dashboardState.decisions.find((item) => item.id === selectedDecisionId)
  if (decision === undefined) return
  const reason = byId("decision-reason").value.trim()
  if (!reason) {
    setStatus("선택 이유나 의견을 입력하세요.", "error")
    byId("decision-reason").focus()
    return
  }
  const selected = document.querySelector('input[name="alternative"]:checked')
  const payload = {
    id: decision.id,
    runId: decision.runId,
    expectedRevision: decision.revision,
    action,
    reason,
    actor: "dashboard",
    idempotencyKey: `dashboard-${crypto.randomUUID()}`,
    decidedAt: new Date().toISOString(),
  }
  if (action === "approve" && selected instanceof HTMLInputElement)
    payload.selected = selected.value
  setStatus("결정을 저장하고 있습니다.", "saving")
  const { response, body } = await api("/api/decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (response.status === 409) {
    await loadState(reason)
    setStatus("다른 탭에서 먼저 변경했습니다. 최신 내용을 확인한 뒤 다시 저장하세요.", "conflict")
    return
  }
  if (!response.ok) throw new Error(body.error ?? "decision_save_failed")
  await loadState()
  setStatus("결정이 원장에 저장되었습니다.", "success")
}

byId("decision-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const submitter = event.submitter
  if (!(submitter instanceof HTMLButtonElement)) return
  const action = submitter.dataset.action
  if (action)
    void saveDecision(action).catch((error) => setStatus(`저장 실패: ${error.message}`, "error"))
})

byId("theme-toggle").addEventListener("click", () => {
  const root = document.documentElement
  const dark =
    root.dataset.theme === "dark" ||
    (root.dataset.theme === undefined && window.matchMedia("(prefers-color-scheme: dark)").matches)
  root.dataset.theme = dark ? "light" : "dark"
  setStatus(`${dark ? "라이트" : "다크"} 모드로 전환했습니다.`)
})

window.addEventListener("resize", centerCurrentStage, { passive: true })

if (!token) setStatus("대시보드 링크의 인증 토큰이 없습니다.", "error")
else void loadState().catch((error) => setStatus(`불러오기 실패: ${error.message}`, "error"))
