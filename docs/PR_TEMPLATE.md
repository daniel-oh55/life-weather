# Pull request template 작성 가이드

Life Weather PR은 [GitHub PR template](../.github/pull_request_template.md)의 모든 섹션을
작성합니다. 해당하지 않는 항목도 비워 두지 말고 `없음` 또는 `해당 없음`과 이유를 적습니다.

## 섹션별 작성법

- **목적 / Summary**: 해결할 문제, 변경 이유와 사용자 또는 개발자에게 미치는 영향을 짧게
  설명합니다.
- **Risk level**: `AGENTS.md` 기준으로 LOW, MEDIUM, HIGH 중 하나를 선택하고 근거를 씁니다.
- **구현 범위**: 실제로 바꾼 앱, 패키지, 문서와 동작을 구체적으로 나열합니다.
- **제외 범위**: 의도적으로 다루지 않은 인접 기능, remote action과 후속 작업을 명시합니다.
- **Acceptance criteria**: 검증 가능한 완료 조건과 각 결과를 checkbox로 기록합니다.
- **Data / secrets / location / identifiers**: 아래 데이터 분류를 적용하고 실제 값은 적지
  않습니다.
- **환경변수**: 변수명의 추가·변경·삭제 여부만 기록하고 값은 포함하지 않습니다.
- **Remote / deploy actions**: 외부 API 호출, Vercel/EAS/console/deploy 여부와 Owner 승인 상태를
  기록합니다.
- **Protected files**: `AGENTS.md`의 보호 영역 변경 여부와 명시적인 Owner scope를 기록합니다.
- **Validation**: 실행한 targeted check와 결과를 요약합니다. 전체 로그를 붙이지 않습니다.
- **CI / Preview**: CI와 Preview를 구분해 실제 상태만 기록합니다.
- **화면 변경 및 screenshot**: UI 변경이 있으면 관련 화면을 첨부하고, 없으면 `없음`으로
  표시합니다.
- **Independent review**: 필요 여부, reviewer와 unresolved finding을 기록합니다. HIGH는
  independent review가 필수입니다.
- **Rollback**: 문제가 생겼을 때 되돌릴 commit, flag 또는 배포 단위를 설명합니다.
- **문서 변경**: 변경했거나 변경이 불필요한 문서와 이유를 기록합니다.
- **Owner actions / 후속 작업**: Ready, merge, deploy, 운영값 입력 등 Owner에게 남은 결정을
  명확히 구분합니다.

## 데이터 분류

- **Secret/credential**: service key, token, credential, signing/private key와 실제 environment
  값입니다. commit, PR 본문, 로그 또는 screenshot에 포함하지 않습니다.
- **Personal or precise location data**: 실제 사용자 좌표, 저장 위치, 이동 기록, device
  identifier와 개인 데이터입니다. synthetic data와 명확히 구분하고 출력하지 않습니다.
- **Operator-managed identifier**: Vercel project/org ID와 production domain, EAS project ID,
  Android application/package identifier, AdMob identifier, support contact 등입니다. 비밀이
  아니더라도 명시적인 Owner scope 없이 agent가 추가하거나 출력하지 않습니다.
- **Safe placeholder/synthetic fixture**: `example.test`, 비어 있는 `.env.example` 변수,
  명시적인 placeholder와 synthetic coordinates처럼 실제 운영자나 사용자를 식별하지 않는
  값입니다.

## CI와 Vercel Preview

- **CI success**는 repository에 정의된 checks가 통과했다는 뜻입니다.
- **Preview READY**는 deploy/build/runtime 환경이 준비되었다는 신호입니다.
- Preview가 READY라는 사실만으로 endpoint behavior가 증명되지는 않습니다.
- endpoint smoke는 명시적인 Owner 승인이 필요한 별도의 remote action입니다.
- docs-only PR에서는 외부 endpoint를 다시 호출할 필요가 없습니다.

PR은 필요한 review gate가 통과하고 Owner가 결정하기 전까지 Draft로 유지합니다.
