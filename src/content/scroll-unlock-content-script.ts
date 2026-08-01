// 스크롤 잠금 해제 콘텐츠 스크립트. body/main 및 최대 2단계 깊이 요소의
// 계산된 overflow가 hidden이면 강제로 visible로 바꾼다. 무조건 동작 —
// "모달일 때만" 같은 휴리스틱 추가 금지 (인터뷰 7회차에서 확정된 사양).
// 매칭되는 DomainRuleEntry의 allOff만이 유일한 탈출구다.
//
// overflow: scroll은 잠금이 아니라 "여기가 스크롤 영역"이라는 정상적인
// 선언이므로(Notion 등) 대상에서 제외한다. 축은 반드시 개별적으로 검사·해제한다
// — overflow-x:hidden; overflow-y:auto 같은 세로 전용 스크롤 컨테이너에서
// 양쪽을 다 visible로 바꾸면 잠기지 않은 축의 정상 스크롤까지 망가진다.

import { getDomainRules, getEnabled, onStorageChange } from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const MAX_DEPTH = 2;
const BLOCKING_OVERFLOW = new Set(["hidden"]);

let active = false;
let observer: MutationObserver | null = null;
// 뮤테이션마다 document.querySelector("main")을 다시 부르면 매칭되는 요소가
// 없을 때 문서 전체를 훑게 되므로 캐시한다.
let scanRoots: Element[] = [];

function unlockIfBlocked(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  const style = window.getComputedStyle(element);
  if (BLOCKING_OVERFLOW.has(style.overflowY)) {
    element.style.setProperty("overflow-y", "visible", "important");
  }
  if (BLOCKING_OVERFLOW.has(style.overflowX)) {
    element.style.setProperty("overflow-x", "visible", "important");
  }
}

function refreshScanRoots(): void {
  const roots: Element[] = [];
  if (document.body) roots.push(document.body);
  const main = document.querySelector("main");
  if (main) roots.push(main);
  scanRoots = roots;
}

function scanDepth(root: Element, depth: number): void {
  unlockIfBlocked(root);
  if (depth >= MAX_DEPTH) return;
  for (const child of root.children) {
    scanDepth(child, depth + 1);
  }
}

function scan(): void {
  if (!document.body) return;
  refreshScanRoots();
  for (const root of scanRoots) {
    scanDepth(root, 0);
  }
  observeAttributesOnScanRoots();
}

// 스캔 범위 밖의 변경은 결과에 영향을 줄 수 없으므로 재검사를 예약하지 않는다.
// 이 필터가 없으면 플레이어·실시간 채팅처럼 깊숙한 곳의 잦은 DOM 변경이
// 프레임마다 scan()을 부르고, getComputedStyle이 강제 레이아웃을 유발한다.
function isWithinScanScope(target: Node): boolean {
  if (scanRoots.length === 0) return false;
  let element: Element | null = target instanceof Element ? target : target.parentElement;
  for (let depth = 0; element && depth <= MAX_DEPTH; depth++) {
    if (scanRoots.includes(element)) return true;
    element = element.parentElement;
  }
  return false;
}

// scan()은 getComputedStyle로 레이아웃을 강제하므로 프레임당 한 번으로 묶는다.
let scanScheduled = false;

function scheduleScan(): void {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scan();
  });
}

// 스크롤 잠금은 거의 항상 최상위 컨테이너 자체에 걸리므로, attributes 관찰은
// subtree 없이 루트 자신에게만 건다.
function observeAttributesOnScanRoots(): void {
  if (!observer) return;
  for (const root of scanRoots) {
    observer.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  }
}

function startObserving(): void {
  stopObserving();
  refreshScanRoots();
  observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => isWithinScanScope(mutation.target))) {
      scheduleScan();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
}

function stopObserving(): void {
  observer?.disconnect();
  observer = null;
  scanScheduled = false;
  scanRoots = [];
}

async function apply(): Promise<void> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);
  const matchedPattern = findMatchingDomainPattern(location.hostname, Object.keys(domainRules));
  const entry = matchedPattern ? domainRules[matchedPattern] : undefined;
  const shouldBeActive = enabled && !entry?.allOff;

  if (shouldBeActive === active) return;
  active = shouldBeActive;

  if (active) {
    if (document.body) {
      startObserving();
    } else {
      document.addEventListener("DOMContentLoaded", () => startObserving(), { once: true });
    }
  } else {
    stopObserving();
  }
}

function runApply(): void {
  void apply().catch((error: unknown) => {
    console.error("[마! 치아라] 스크롤 잠금 해제를 적용하지 못했습니다.", error);
  });
}

runApply();

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules) {
    runApply();
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    runApply();
  }
});
