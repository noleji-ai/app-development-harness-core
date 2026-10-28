# 먼저 읽으세요 — Noleji Launch 다른 Mac 이전 번들

이 번들은 검증된 App Development Harness 플러그인과 현재 Noleji Launch 전체 소스 아카이브를
다른 Mac mini 또는 MacBook의 새 Codex 세션으로 옮기기 위한 로컬 전용 전달물입니다. 자격증명,
`.git`, 실행 중인 `.app-harness`, `.omo`/`.omx` 상태, 의존성 디렉터리, 빌드 캐시, 소켓,
개인 Tailscale 정보는 포함하지 않습니다.

이 번들의 체크섬과 로컬 기계 검증은 통과했지만, 내부 최종 검토 상태를 인계하거나 승인으로
간주하지 않습니다. 새 세션은 전달된 소스의 활성 계획·상태·append-only 원장을 먼저 확인하고
미완료 검토를 그대로 이어야 합니다. 외부 배포, DNS 변경, 결제·메일 자격증명 사용, Apple
서명·공증·TestFlight·App Store 제출은 승인하지 않습니다. 이 번들의 기본 정책은
**외부 배포 금지**입니다.

## 1. 받은 파일과 SHA-256

| 파일 | 일반 파일 | 아카이브 항목 | SHA-256 |
| --- | ---: | ---: | --- |
| `artifacts/app-development-harness-0.1.0-macos.zip` | @HARNESS_FILES@ | @HARNESS_ENTRIES@ | `@HARNESS_SHA256@` |
| `artifacts/noleji-launch-source.tar.gz` | @NOLEJI_FILES@ | @NOLEJI_ENTRIES@ | `@NOLEJI_SHA256@` |

전달 ZIP과 옆의 `.sha256`을 같은 폴더에 둔 뒤 실행합니다.

```sh
shasum -a 256 -c noleji-launch-mac-transfer-0.1.0.zip.sha256
unzip -q noleji-launch-mac-transfer-0.1.0.zip
cd noleji-launch-mac-transfer
shasum -a 256 -c SHA256SUMS
cd artifacts
shasum -a 256 -c app-development-harness-0.1.0-macos.zip.sha256
shasum -a 256 -c noleji-launch-source.tar.gz.sha256
cd ..
```

하나라도 실패하면 설치를 중단합니다. 위 표의 두 SHA-256도 실제 출력과 정확히 같아야 합니다.

## 2. 준비 상태와 정직한 차단 조건

```sh
node --version
bun --version
codex --version
xcodebuild -version
swift --version
tailscale version
docker --version
```

- Node.js 22 이상은 번들된 하네스 CLI를 실행합니다.
- Bun 1.3 이상은 소스를 다시 설치·검사·빌드할 때만 필요합니다.
- 호환성 레지스트리는 Apple 출시 검증을 **Xcode 26.6**으로 고정합니다. 현재 Mac의 Xcode가
  더 낮거나 SDK·시뮬레이터·서명 ID·archive/upload 검사가 없으면 `blocked/unverified`입니다.
- 데이터베이스 기준은 **PostgreSQL 18.4**입니다. 승인된 로컬 PostgreSQL과 실제 마이그레이션
  검증이 없으면 출시 준비 완료로 바꾸지 않습니다.
- `tailscale version`만 기본 점검에 사용합니다. `tailscale status`, 기기 이름, tailnet IP,
  계정, 경로, auth/device key는 증거나 번들에 기록하지 않습니다.

## 3. App Development Harness 설치

```sh
unzip -q artifacts/app-development-harness-0.1.0-macos.zip
export BUNDLE_ROOT="$PWD/app-development-harness-bundle"
codex plugin marketplace add "$BUNDLE_ROOT"
codex plugin add app-development-harness@app-harness-local
codex plugin list --marketplace app-harness-local --available --json
```

설치 후 새 Codex 세션을 시작해야 스킬과 훅이 깨끗한 경계에서 로드됩니다. 새 세션의 채팅에는
다음 명령을 순서대로 입력할 수 있습니다.

```text
$app-harness doctor
$app-harness init
$app-harness dashboard --open
```

하네스의 공개 명령은 정확히 `init`, `run`, `resume`, `status`, `verify`, `dashboard`,
`doctor`, `upgrade` 8개입니다.

## 4. 소스 풀기와 로컬 기준선 만들기

```sh
mkdir -p workspace
tar -xzf artifacts/noleji-launch-source.tar.gz -C workspace
export PROJECT_ROOT="$PWD/workspace/noleji-launch"
git -C "$PROJECT_ROOT" init
git -C "$PROJECT_ROOT" add .
git -C "$PROJECT_ROOT" -c user.name="Local Handoff" \
  -c user.email="local-handoff@example.invalid" commit -m "Create local handoff baseline"
```

소스에는 웹·iOS·macOS, 서비스, 계약, 문서, 디자인 자산, 마케팅 캡처와 검토 증거가
포함됩니다. 기존 Git 이력과 실행 중이던 하네스 상태는 의도적으로 포함하지 않습니다.

## 5. 직접 CLI로 초기화·진단·대시보드 열기

```sh
export HARNESS_CLI="$BUNDLE_ROOT/plugins/app-development-harness/dist/cli.js"
node "$HARNESS_CLI" init --project "$PROJECT_ROOT" --mode extend
node "$HARNESS_CLI" doctor --project "$PROJECT_ROOT"
node "$HARNESS_CLI" status --project "$PROJECT_ROOT"
node "$HARNESS_CLI" dashboard --project "$PROJECT_ROOT" --open
```

대시보드는 `127.0.0.1`에만 바인딩되고 임의 토큰은 URL fragment에만 둡니다. HTML은
append-only 결정 원장을 보여주는 화면이며 별도 원본이 아닙니다.

새 서비스 또는 대규모 전체 구축 요청은 파일로 전달합니다.

```sh
printf '%s\n' '완성할 제품 결과, 사용자, 대상 플랫폼과 제약을 설명합니다.' \
  > "$PROJECT_ROOT/product-request.md"
node "$HARNESS_CLI" run --project "$PROJECT_ROOT" --mode extend \
  --request-file product-request.md
```

`resume`은 같은 프로젝트의 `.app-harness/` 상태가 있고 `doctor`가 호환 lock protocol을
확인했을 때만 사용합니다. 질문, 리뷰, 작은 수정에는 전체 파이프라인을 자동 적용하지 않습니다.

## 6. 로컬 검증과 미리보기

```sh
cd "$PROJECT_ROOT"
scripts/release/verify-source-archive.sh \
  "$OLDPWD/artifacts/noleji-launch-source.tar.gz"
(cd apps/web && bun install --frozen-lockfile && bun run check && bun test && bun run build)
(cd services/control-plane && go test -race ./... && go vet ./...)
NOLEJI_PROJECT_API_MODE=fixture bun --cwd apps/web run start --port 3000
```

마지막 명령은 명시적인 로컬 fixture 미리보기입니다. 공개 바인딩, 외부 모델 호출, 결제, 메일,
실제 배포를 승인하지 않습니다.

## 7. Tailscale 또는 사용자 지정 주소로 연결

앱의 Runner 연결 화면에서는 승인된 환경에 맞춰 `Tailscale DNS`, `Tailscale IP`,
`사용자 지정 HTTPS` 중 하나를 선택할 수 있습니다. 주소에는 사용자명·비밀번호·토큰·fragment를
넣지 않습니다. Tailscale IP는 전용 CGNAT/IPv6 범위만, 사용자 지정 주소는 HTTPS만 허용합니다.

웹·Control Plane·App Harness 대시보드는 계속 `127.0.0.1`에 둡니다. 다른 Mac에서 대시보드나
로컬 웹을 확인할 때는 이미 승인된 tailnet 위에서 인증된 SSH 포트 포워딩을 사용합니다.

```sh
ssh -L 3000:127.0.0.1:3000 APPROVED_TAILNET_HOST
```

연결하는 Mac에서는 `http://127.0.0.1:3000`을 엽니다. Tailscale ACL·기기·라우트·DNS,
Serve/Funnel, 공개 ingress를 새로 만들거나 바꾸지 않습니다. 다른 사설 IP를 쓰는 경우에도
별도 승인된 TLS 종단과 방화벽이 있어야 하며 하네스 대시보드를 직접 공개 IP에 바인딩하지 않습니다.

## 8. 새 Codex 세션에 그대로 전달할 지침

```text
START-HERE.md, 설치된 app-harness SKILL.md, Noleji Launch README.md,
release/handoff/checklist.md, registry/compatibility.v1.json을 끝까지 읽어. 먼저 모든 SHA-256을
검증하고 App Harness doctor와 status를 실행해. 활성 계획·상태·append-only 원장의 최신 이벤트를
확인하고, 미완료 통합 작업과 최종 검토를 승인으로 간주하지 말고 그대로 이어가. 신규 서비스 또는
대규모 구축에는 앱 개발 하네스를 사용하고, 사용자에게 기술 이름을 고르게 하지 말고 제품 가치와
품질 기준으로 최적안을 제안해. PRD/범위와 디자인 시안은 대시보드에서 보여주고 이미지 시안도
확인 가능하게 해. 모든 서비스는 loopback-only로 유지해. 자격증명을 사용하거나 Tailscale/DNS를
변경하거나 외부 배포, 서명, 공증, App Store 제출을 하지 마. Xcode 26.6, PostgreSQL 18.4,
Apple/외부 도구가 없으면 blocked 또는 unverified로 보고하고 절대 성공으로 대체하지 마.
```

남은 정직한 차단 항목은 Xcode 26.6에서의 Apple 출시 검증, 서명·공증·TestFlight/App Store,
승인된 PostgreSQL 18.4 실데이터 마이그레이션, 운영 결제·메일 자격증명, DNS/공개 ingress,
실제 외부 배포입니다. 별도 권한 없이는 실행하지 않습니다.
