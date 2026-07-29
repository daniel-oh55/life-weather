# Life Weather AI 운영 정책

이 문서는 Life Weather 저장소에서 장기간 유지하는 AI 작업 정책의 기준입니다. 모든 AI 작업은
명시된 범위 안에서 최소 변경으로 수행하고, 사실과 검증 상태는 현재 저장소와 GitHub에서 다시
확인합니다.

## 지시 우선순위와 근거의 역할

### 지시 우선순위

1. Owner의 명시적 지시는 허용된 작업 범위와 Owner gate를 정의합니다.
2. `AGENTS.md`는 장기간 유지하는 운영 정책의 canonical source입니다.
3. 관련 architecture, security, contract, runbook 문서는 Owner 범위와 `AGENTS.md`를 전제로
   각각의 기술 계약을 규정합니다.

### 근거와 맥락

- 현재 저장소 코드, GitHub PR diff와 checks는 실제 구현 및 검증 상태의 canonical evidence입니다.
- 기존 코드나 PR diff는 Owner 범위 또는 `AGENTS.md`를 재정의하지 않습니다.
- [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)는 현재 baseline, 미완료 작업과 다음 의사결정을
  기록합니다.
- 채팅의 완료 보고는 보조 맥락이며 저장소나 GitHub의 근거를 대신하지 않습니다.

## 역할 분리

- 하나의 PR에는 Codex 또는 Claude Code 중 한 명만 primary implementer로 지정합니다.
- 다른 모델은 위험도 또는 구체적인 finding이 정당화할 때 independent reviewer로 참여합니다.
- 동일 작업을 여러 모델이 처음부터 중복 구현하지 않습니다.
- ChatGPT는 scope, risk, acceptance criteria, review와 Owner gate를 조정합니다.
- Owner만 PR의 Ready 전환, merge, deploy와 외부 콘솔 작업을 결정합니다.

## 위험 등급

### LOW

- 문서와 오탈자
- 동작하지 않는 repository template
- 실제 동작을 바꾸지 않는 주석과 상태 정정

### MEDIUM

- 일반 모바일 UI와 presentation, formatting
- 기존 계약이나 보안 경계를 바꾸지 않는 refactor
- 테스트 강화
- 기존 정책값을 바꾸지 않는 additive presentation 작업

### HIGH

- KMA 또는 AirKorea API key와 environment 처리
- 외부 provider HTTP request/response boundary
- provider timeout, abort, retry, fallback eligibility와 source selection
- KMA issuance identity와 source metadata
- 모바일–API request/response contract 또는 `CONTRACT_VERSION`
- 위치 권한, 좌표, 위치 저장·전송·정밀도와 개인위치정보 처리
- production Hono route, composition root와 presenter error boundary
- Vercel entrypoint, Node ESM, package exports와 runtime shared-package build
- package, dependency, lockfile, build 또는 deployment config
- lifestyle-engine recommendation policy, version 또는 threshold의 의미 변경
- AdMob, consent, privacy, Android native config, EAS 또는 Play 배포
- 실제 외부 API 호출 또는 remote deployment

HIGH 작업은 independent review가 필수입니다. 명시적인 Owner 승인 전에는 Ready 전환, merge 또는
deploy를 수행하지 않습니다.

## 비밀, 개인정보와 운영 식별자

다음 값은 commit하거나 출력하지 않습니다.

- 실제 KMA/AirKorea service key
- API token, credential, signing key와 private key
- 실제 `.env` 또는 `.env.local` 값
- 실제 사용자 좌표, 저장 위치, 이동 기록과 device identifier
- private/internal e-mail과 개인 데이터
- key 또는 민감 query가 포함된 provider URL
- 실제 upstream raw response 중 민감하거나 불필요한 내용

다음 operator-managed identifier는 모두 비밀이 아닐 수 있지만, 명시적인 Owner scope 없이 agent가
commit하거나 출력하지 않습니다.

- 실제 Vercel project/org ID와 production domain
- 실제 EAS project ID
- Android application/package identifier
- AdMob App ID와 ad unit ID
- public support contact와 법적 문서에 들어가는 운영 정보
- production environment value

허용되는 값은 `example.test`, 비어 있는 `.env.example` 변수, 명시적인 placeholder, synthetic
fixture와 synthetic coordinates, 저장소에서 이미 승인된 비민감 static identifier입니다.

## 보호 영역

다음 영역은 명시적인 scope와 Owner 승인 없이 변경하지 않습니다.

- `packages/contracts/`, `CONTRACT_VERSION`과 runtime schemas
- `packages/weather-core/`의 KMA product/source/issuance/location 정책
- `packages/lifestyle-engine/`의 policy/version/threshold와 decision semantics
- `apps/api/src/providers/`
- `apps/api/src/services/`
- `apps/api/src/composition/`
- `apps/api/src/routes/`
- `apps/api/src/presenters/`
- `apps/api/src/index.ts`
- `apps/api/src/api-app.ts`
- test fixture와 expected result/decision matrix
- package `main`/`types`/`exports`와 Node ESM specifier contract
- `build:api-runtime-packages`, verify scripts, `postinstall`과 build-first
  `typecheck`/`test`/`check` contract
- `apps/api/tsconfig.json`과 Vercel entrypoint/runtime config
- mobile app config, EAS config와 Android/iOS native generation policy
- `.env` example의 변수명 계약

## Remote 및 파괴 작업

다음 작업은 명시적인 Owner 승인 없이 수행하지 않습니다.

- Vercel login/link/deploy/env 변경과 project/domain 생성 또는 변경
- EAS login/build/submit/project 연결
- Play Console, AdMob 또는 기타 외부 콘솔 변경
- 실제 KMA/AirKorea endpoint smoke call
- production environment 변경
- 실제 user/device location test
- native prebuild 산출물 commit
- force-push 또는 history rewrite
- `main` 직접 수정

## 검사 정책

- 변경 범위에 맞는 targeted checks를 우선합니다.
- runtime 또는 contract 변경에는 관련 package test와 전체 `pnpm check`가 필요합니다.
- docs-only PR도 기존 CI의 `pnpm check` 결과를 확인합니다.
- shared package는 compiled `dist` entrypoint를 사용하므로 public `typecheck`/`test`/`check`의
  build-first 정책을 우회하지 않습니다.
- `dist`를 수동 편집하거나 commit하지 않습니다.
- `pnpm check`에서 shared runtime package build가 한 번만 수행되는 기존 계약을 임의로
  변경하지 않습니다.
- 테스트를 삭제하거나 완화해서 CI를 통과시키지 않습니다.
- 기존 검증으로 충분하면 새 checker를 만들지 않습니다.
- 외부 API 실호출을 unit 또는 integration test의 대체로 사용하지 않습니다.

## 완료 보고

다음 항목만 간결하게 보고합니다.

- branch와 새 HEAD
- changed files와 핵심 변경
- targeted checks와 CI 상태
- 보호 영역, 비밀과 실제 값의 무변경 여부
- PR의 Draft/Open 상태
- 남은 Owner action

전체 명령 로그나 과거 PR 설명은 반복하지 않습니다.
