# 마! 치아라 — 광고 제거기

Chrome Manifest V3 확장 프로그램. 빌드 시점에 EasyList/EasyPrivacy를 번들하여 네트워크·콘텐츠(cosmetic) 광고를 차단하고, 스크롤 잠금을 자동으로 해제하며, 단축키로 원하는 요소를 직접 골라 제거하고, 도메인별로 하나의 통합 관리 목록에서 차단 여부를 세밀하게 제어한다 — MV3의 제약 안에서 uBlock Origin *Lite* 수준의 광고 제거를 목표로 한다.

## 주요 기능

- **네트워크 차단**: EasyList/EasyPrivacy를 declarativeNetRequest 정적 규칙으로 변환해 광고·트래커 요청을 차단
- **콘텐츠(cosmetic) 차단**: EasyList의 CSS 선택자 기반으로 광고 요소를 DOM에서 제거
- **스크롤 잠금 자동 해제**: 광고/팝업이 남기는 `overflow: hidden` 등의 스크롤 잠금 오버레이를 감지해 해제
- **요소 선택기**: 단축키(`Alt+Shift+P`, `chrome://extensions/shortcuts`에서 변경 가능)로 원하는 요소를 직접 클릭해 제거, 도메인별로 영속 저장
- **도메인 관리 목록**: 자동 식별(네트워크/콘텐츠 규칙)과 수동 식별(요소 선택기) 항목을 도메인별로 통합 관리, 개별 항목 해제 또는 도메인 "전체 끄기" 지원, 와일드카드 도메인 패턴(`naver*.com`) 지원

## 설치 (개발자 모드)

```
npm install
npm run build     # 프로덕션 빌드 -> dist/
```

`chrome://extensions`(또는 웨일의 `whale://extensions`)에서 개발자 모드를 켜고 "압축해제된 확장 프로그램을 로드합니다"로 `dist/` 폴더를 선택한다.

## 개발

```
npm install
npm run dev       # Vite 개발 서버 (CRXJS가 언패킹된 확장 프로그램을 핫 리로드)
npm run build     # 프로덕션 빌드 -> dist/
npm run typecheck
```

`chrome://extensions`에서 `dist/`를 언패킹된 확장 프로그램으로 로드한다 (개발자 모드 활성화, "압축해제된 확장 프로그램을 로드합니다").

## 필터 규칙 다시 빌드하기

네트워크 및 콘텐츠 규칙은 빌드 시점에 EasyList/EasyPrivacy로부터 번들된다 — 런타임 가져오기나 자동 업데이트는 없다 (의도된 설계다; MV3의 원격 코드 정책과 명시적인 제로 비용·프라이버시 우선 제약 때문이다). 최신 업스트림 필터 목록으로 새로고침하려면:

```
npm run build:filters
```

이 명령은 `@adguard/tsurlfilter`를 통해 EasyList와 EasyPrivacy를 다시 다운로드/변환하고, `src/rules/dnr-ruleset-*.json`을 재생성하며(Chrome의 3만 개 활성-정적-규칙 및 약 1,000개 `regexFilter` 상한선 아래로 유지하기 위해 여러 파일로 분할), `src/rules/cosmetic-selectors.json`을 재생성하고, `src/rules/filter-metadata.json`(규칙 개수, 빌드 시각 — 확장 프로그램의 Options 페이지에 표시됨)을 작성한다. `scripts/build-filter-rules.ts`의 빌드 타임 검증은 변환된 규칙 개수가 Chrome의 상한선을 초과할 경우, 조용히 잘라내는 대신 요란하게 실패한다 (0이 아닌 종료 코드).

`npm run build`는 항상 먼저 `build:filters`를 실행하므로, 전체 빌드는 `.cache/filter-sources/`에 캐시된 것과 비교해서 오래된 규칙을 배포하는 일이 없다.

## 도메인 관리 목록

옵션 페이지의 "도메인 관리" 하나로 도메인별 차단 여부를 관리한다 (예전의 분리된 화이트리스트/블랙리스트를 대체). 각 항목은 글롭 스타일 와일드카드 도메인 패턴(예: `naver*.com`, 순수 정규식 아님)을 키로 한다.

- **전체 끄기**: 해당 도메인에서 네트워크 계층(DNR)과 모든 콘텐츠 스크립트 양쪽 모두 확장 프로그램을 완전히 비활성화한다 — 사이트는 확장 프로그램이 설치되지 않은 것처럼 동작한다.
- **개별 항목 해제**: 팝업을 열면 그 탭에서 실제로 차단된 네트워크 규칙을 `chrome.declarativeNetRequest.getMatchedRules`로 조회해 옵션 페이지에 표시한다. 각 항목을 개별적으로 차단 해제할 수 있으며, 이는 세션 범위 DNR allow 규칙(`initiatorDomains` 기반 — 요청 URL이 아니라 요청을 시작한 페이지와 매칭)으로 구현된다. 콘텐츠 선택자도 같은 방식으로 개별 해제 가능하다.
- **요소 선택기 영속성**: 선택기로 제거한 요소는 도메인별로 기억되며, 전체 끄기 상태가 아닌 한 이후 방문할 때마다 자동으로 다시 적용된다 (별도 옵트인 불필요).

DNR의 `initiatorDomains`는 리터럴 도메인만 받고 와일드카드를 지원하지 않으므로, 각 콘텐츠 스크립트가 페이지 로드시 자신의 호스트명을 백그라운드에 보고해 패턴에 매칭되는 리터럴 호스트명 목록(`knownHostnames`)을 점진적으로 채운다 — 이를 위해 별도 권한(`webNavigation` 등)을 추가하지 않았다.

## 알려진 제약사항 (버그가 아니라 받아들인 트레이드오프)

- 필터 목록은 수동으로 다시 빌드해야 한다(`npm run build:filters`); 자동 업데이트는 없다.
- 저장된 수동 제거 요소는 URL 경로가 아니라 도메인 단위로 키가 지정된다 — 제거는 해당 도메인 전체에 적용된다.
- 팝업/옵션 UI의 "차단 개수"는 최선-노력 방식의 근사치다 — Manifest V3는 프로덕션 빌드에서 탭별 정확한 DNR 매칭 개수를 제공하지 않는다.
