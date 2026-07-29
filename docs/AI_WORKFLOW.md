# Life Weather AI 작업 흐름

이 문서는 [`../AGENTS.md`](../AGENTS.md)의 운영 정책을 Life Weather PR 흐름에 적용하는 방법을
설명합니다.

## 역할과 기본 흐름

1. ChatGPT가 Owner와 함께 scope, risk level, acceptance criteria와 Owner gate를 정리합니다.
2. Codex 또는 Claude Code 중 한 명만 primary implementer로 지정합니다.
3. implementer는 허용 범위 안에서 변경하고 변경 성격에 맞는 targeted local validation을
   수행합니다.
4. 변경을 Draft PR로 올리고 GitHub diff와 checks를 근거로 검토합니다.
5. finding을 수정한 뒤에는 해당 finding과 관련된 diff를 먼저 focused review합니다.
6. Owner가 검토 결과를 확인하고 Ready 전환, merge와 deploy 여부를 결정합니다.

Owner의 명시적 승인 없이는 agent가 Ready 전환, merge, remote deploy 또는 외부 콘솔 작업을
수행하지 않습니다.

## 위험도별 검토 깊이

- **LOW**: 문서, 오탈자, 비동작 template처럼 실제 동작을 바꾸지 않는 변경입니다. primary
  implementer의 targeted validation과 GitHub diff/check 검토를 기본으로 하며, 불필요한 다중
  모델 구현이나 검토를 추가하지 않습니다.
- **MEDIUM**: UI/presentation, contract와 보안 경계를 유지하는 refactor, 테스트 강화 등입니다.
  영향 영역의 테스트와 회귀 가능성을 검토하고 필요할 때 focused review를 추가합니다.
- **HIGH**: provider, contract, 위치정보, production route, package/build/deployment, 정책 의미,
  native/광고/배포 경계를 건드리는 변경입니다. 관련 전체 검증과 independent review가
  필수이며, 명시적인 Owner 승인 전 Ready, merge와 deploy가 금지됩니다.

## 검증과 원격 신호

- 로컬에서는 변경 범위에 맞는 검사를 우선하고, runtime/contract 변경에는 관련 package test와
  전체 `pnpm check`를 수행합니다.
- Draft PR에서는 GitHub의 실제 diff와 CI checks를 기준으로 검토합니다.
- Vercel Preview 상태는 build/deploy/runtime 환경 신호이며 endpoint 동작 증명과 같지 않습니다.
- 외부 API 또는 Preview endpoint smoke는 별도의 Owner-approved remote action입니다.
- docs-only 변경에서는 Vercel Preview나 외부 API를 불필요하게 재호출하지 않습니다.

## 작업 및 토큰 효율

- 매 작업마다 저장소 전체나 과거 대화를 다시 설명하지 않습니다.
- GitHub PR, `AGENTS.md`와 [`PROJECT_STATE.md`](PROJECT_STATE.md)를 기준으로 현재 상태를
  이어갑니다.
- 전체 명령 로그를 복사하지 않고 결과와 필요한 근거만 남깁니다.
- remediation 후에는 전체를 처음부터 반복하기 전에 finding 관련 diff를 집중 검토합니다.
- LOW-risk 작업에 여러 모델의 중복 구현이나 정당한 이유 없는 independent review를 추가하지
  않습니다.
- 이미 충분한 CI/Preview 신호가 있으면 Vercel Preview나 외부 API를 다시 호출하지 않습니다.
