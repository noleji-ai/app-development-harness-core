export interface PromptRoute {
  matched: boolean
  advisory?: string
}

const EXCLUSIONS = [
  /\b(explain|question|review|audit|inspect|analy[sz]e|small bug|minor fix|typo)\b/i,
  /(설명|질문|리뷰|검토|분석|작은\s*버그|오타|간단한\s*수정)/,
]
const BUILD_INTENT = [
  /\b(build|create|develop|implement|rebuild|rewrite|launch)\b/i,
  /(만들|개발|구축|구현|재구축|전면\s*개편|새로)/,
]
const PRODUCT = [
  /\b(app|application|platform|service|product|website|web app|api|backend|mobile)\b/i,
  /(앱|애플리케이션|플랫폼|서비스|제품|웹사이트|백엔드|모바일)/,
]
const LARGE_SCOPE = [
  /\b(new|from scratch|end[- ]to[- ]end|full|complete|major|large|greenfield)\b/i,
  /(신규|처음부터|전체|전면|대규모|완제품)/,
]

export function routeUserPrompt(rawPrompt: string): PromptRoute {
  const prompt = rawPrompt.trim()
  if (!prompt || prompt.includes("$app-harness") || EXCLUSIONS.some((rule) => rule.test(prompt))) {
    return { matched: false }
  }
  const matched =
    BUILD_INTENT.some((rule) => rule.test(prompt)) &&
    PRODUCT.some((rule) => rule.test(prompt)) &&
    LARGE_SCOPE.some((rule) => rule.test(prompt))
  if (!matched) return { matched: false }
  return {
    matched: true,
    advisory:
      "This appears to be a new or large application build. Consider `$app-harness init` " +
      "followed by `$app-harness run`. This is advisory only; preserve the user's explicit workflow choice.",
  }
}
