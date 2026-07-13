// 스크롤 잠금 해제 콘텐츠 스크립트. body/main 및 최대 2단계 깊이 요소의
// 계산된 overflow가 hidden|scroll이면 강제로 visible로 바꾼다. 무조건
// 동작 — "모달일 때만" 같은 휴리스틱 추가 금지 (인터뷰 7회차에서 명시적으로
// 확정된 사양). 매칭되는 DomainRuleEntry의 allOff만이 유일한 탈출구다.

import { getDomainRules, getEnabled, onStorageChange } from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const MAX_DEPTH = 2;
const BLOCKING_OVERFLOW = new Set(["hidden", "scroll"]);

let active = false;
let observer: MutationObserver | null = null;

function isScrollBlocked(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return (
    BLOCKING_OVERFLOW.has(style.overflow) ||
    BLOCKING_OVERFLOW.has(style.overflowY) ||
    BLOCKING_OVERFLOW.has(style.overflowX)
  );
}

function unlockIfBlocked(element: Element): void {
  if (!(element instanceof HTMLElement)) return;
  if (isScrollBlocked(element)) {
    element.style.setProperty("overflow", "visible", "important");
    element.style.setProperty("overflow-x", "visible", "important");
    element.style.setProperty("overflow-y", "visible", "important");
  }
}

function candidateRoots(): Element[] {
  const roots: Element[] = [document.body];
  const main = document.querySelector("main");
  if (main) roots.push(main);
  return roots.filter((el): el is Element => Boolean(el));
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
  for (const root of candidateRoots()) {
    scanDepth(root, 0);
  }
}

// style/class 속성 변화는 재생바·로딩 인디케이터가 있는 페이지(YouTube 등)에서
// 초당 여러 번 발생한다. scan()은 getComputedStyle을 호출해 레이아웃을
// 강제하므로, 뮤테이션마다 동기 실행하면 메인 스레드를 막아 영상이 끊긴다.
// requestAnimationFrame으로 묶어 프레임당 최대 한 번만 실행한다.
let scanScheduled = false;

function scheduleScan(): void {
  if (scanScheduled) return;
  scanScheduled = true;
  requestAnimationFrame(() => {
    scanScheduled = false;
    scan();
  });
}

function startObserving(): void {
  stopObserving();
  scan();
  observer = new MutationObserver(() => {
    scheduleScan();
  });
  const target = document.documentElement;
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });
}

function stopObserving(): void {
  observer?.disconnect();
  observer = null;
  scanScheduled = false;
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

void apply();

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules) {
    void apply();
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    void apply();
  }
});

export {};
