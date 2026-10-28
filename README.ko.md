# 중단한 AI 개발 작업을 이어가고 검증 기록을 확인하기

App Development Harness Core는 앱 개발 작업의 상태·결정·검사 근거를 남기는 명령줄 도구와 Codex 플러그인입니다. 작은 오픈소스 팀도 재현 가능한 흐름을 사용하도록 기존 1.2.0 소스를 정리했습니다. [English](README.md)

## 먼저 로컬 예제로 확인하기

macOS와 Node.js 22 이상을 기준으로 확인합니다. `dist/` 실행 파일로 의존성 설치나 모델 호출 없이 새 임시 폴더의 초기화·상태·진단을 확인할 수 있습니다.

```sh
node dist/cli.js --help
DEMO_PROJECT=$(mktemp -d)
node dist/cli.js init --project "$DEMO_PROJECT" --mode create
node dist/cli.js status --project "$DEMO_PROJECT"
node dist/cli.js doctor --project "$DEMO_PROJECT"
```

초기화만으로 개발이 시작되지는 않습니다. `initialized: true`와 `activeRun: null`, 임시 폴더의 기록을 확인하세요. 예제는 기존 앱 폴더를 수정하지 않습니다.

## 실제 개발 실행과 확인 범위

`run`·`resume`은 Codex와 프로젝트 도구를 실행할 수 있습니다. 실제 사용 전 계정·권한·SDK·비용 한도를 확인하세요. API는 모델을 프로그램으로 호출하는 방식이며 ChatGPT 구독과 별도로 확인해야 합니다.

[현재 검증](docs/verification.md)은 실행한 검사와 한계를 설명합니다. 다른 운영체제·실제 모델 결과·앱 출시·보안 인증·공교육 채택을 증명하지 않습니다. 외부 재사용은 아직 확인되지 않았습니다.

## 공개 기술로 개선할 부분

중단·재개 오류, 버전 호환성, 복원 확인과 설명이 어려운 단계를 작은 예제로 제보해 주세요. [기여 안내](CONTRIBUTING.md)에 따라 버전·기대/실제 결과·검사 명령을 남기고 비밀번호·API 키·고객/학생 자료는 제외합니다.

향후 목표는 실제 문제를 수정하고 한국어·영문 안내와 호환성 사례를 갱신하는 것입니다. 비공개 이력을 공개하지 않았으며 새 저장소 날짜를 과거 공개 실적으로 쓰지 않습니다. [유지보수 계획](MAINTENANCE.md)과 [출처](PROVENANCE.md)를 함께 확인하세요.

기존 MIT 라이선스와 Zod 고지를 보존했습니다. 디자인 참고 이미지·비공개 업무 자료는 제외했습니다. OpenAI 공식 프로젝트·추천·지원금 선정이나 무료 사용량을 보장하는 서비스가 아닙니다.
