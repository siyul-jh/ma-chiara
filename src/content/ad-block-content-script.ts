// 콘텐츠(광고) 제거 콘텐츠 스크립트. document_start 시점에 SW를 거치지
// 않고 chrome.storage.local을 직접 읽는다 (SW 콜드 스타트 경쟁 상태 회피).

import cosmeticSelectors from "../rules/cosmetic-selectors.json";
import {
  getCustomRemovedElements,
  getDomainRules,
  getEnabled,
  incrementStats,
  onStorageChange,
} from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const BASE_SELECTORS: string[] = Array.isArray(cosmeticSelectors)
  ? (cosmeticSelectors as string[])
  : [];

// storage 읽기는 비동기라 document_start 시점에 첫 페인트 전 커스텀 선택자를
// 못 가져올 수 있어 재방문 시 깜빡임이 생긴다. localStorage(동기)에 마지막
// 목록을 캐시해두고 스크립트 평가 즉시 CSS로 선(先)숨김 처리한다.
const PRE_HIDE_CACHE_KEY = "__ma-chiara-custom-selectors-cache__";
const PRE_HIDE_STYLE_ID = "__ma-chiara-pre-hide-style__";

function readPreHideCache(): string[] {
  try {
    const raw = localStorage.getItem(PRE_HIDE_CACHE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writePreHideCache(selectors: string[]): void {
  try {
    localStorage.setItem(PRE_HIDE_CACHE_KEY, JSON.stringify(selectors));
  } catch {
    // 용량 초과 등 — 최선-노력.
  }
}

function applyPreHideStyle(selectors: string[]): void {
  let styleEl = document.getElementById(PRE_HIDE_STYLE_ID) as HTMLStyleElement | null;
  if (selectors.length === 0) {
    styleEl?.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = PRE_HIDE_STYLE_ID;
    (document.head ?? document.documentElement).appendChild(styleEl);
  }
  styleEl.textContent = selectors.map((selector) => `${selector} { display: none !important; }`).join("\n");
}

// 캐시로부터의 동기적 사전 숨김 — 어떤 비동기 스토리지 읽기보다도 먼저
// 실행되어야 반복 방문 시의 깜빡임을 없앤다.
applyPreHideStyle(readPreHideCache());

let observer: MutationObserver | null = null;
let appliedCustomSelectors: string[] = [];

function reportHostname(): void {
  try {
    void chrome.runtime.sendMessage({ type: "report-hostname", hostname: location.hostname });
  } catch {
    // SW 재시작 중 등 — 최선-노력.
  }
}

// querySelectorAll에 콤마로 합친 선택자 목록을 넘길 때 하나라도 문법이
// 잘못되면 SyntaxError로 전체가 실패하므로, 도메인 진입 시 한 번만 개별
// 검증 후 합친다. 이 비용을 뮤테이션마다 반복하지 않기 위함.
function compileSelectorList(selectors: string[]): string {
  const probe = document.createDocumentFragment();
  const valid: string[] = [];
  for (const selector of selectors) {
    try {
      probe.querySelector(selector);
      valid.push(selector);
    } catch {
      continue;
    }
  }
  return valid.join(",");
}

// 선택자 13,000개 이상을 뮤테이션마다 하나씩 querySelectorAll 하던 이전
// 방식은 DOM이 계속 바뀌는 페이지(YouTube 등)에서 메인 스레드를 막아 영상이
// 끊기는 원인이었다. 미리 컴파일한 단일 콤마 목록으로 querySelectorAll을
// 한 번만 호출해 같은 결과를 훨씬 저렴하게 얻는다.
function removeMatchesInDocument(combinedSelector: string): void {
  if (!combinedSelector) return;
  let elements: NodeListOf<Element>;
  try {
    elements = document.querySelectorAll(combinedSelector);
  } catch {
    return;
  }
  let removedCount = 0;
  for (const element of elements) {
    if (element.isConnected) {
      element.remove();
      removedCount++;
    }
  }
  if (removedCount > 0) {
    void incrementStats(location.hostname, { cosmeticRemoved: removedCount });
  }
}

// 커스텀(요소 선택기) 선택자는 :nth-child 기반 위치 선택자라 문서 전체를
// 반복 재매칭하면 위험하다: 요소 제거 자체가 뮤테이션이라 옵저버가 재실행될
// 때 비워진 nth-child 위치로 밀려든 형제가 같은 선택자와 매칭되어 연쇄
// 삭제된다. addedNodes(새로 삽입된 노드)에서만 재매칭해 이를 피한다.
function removeMatchesInAddedNodes(selectors: string[], addedNodes: readonly Node[]): void {
  if (selectors.length === 0 || addedNodes.length === 0) return;
  let removedCount = 0;
  for (const node of addedNodes) {
    if (!(node instanceof Element) || !node.isConnected) continue;
    for (const selector of selectors) {
      let matches: Element[];
      try {
        matches = node.matches(selector) ? [node] : [...node.querySelectorAll(selector)];
      } catch {
        continue;
      }
      for (const element of matches) {
        if (element.isConnected) {
          element.remove();
          removedCount++;
        }
      }
    }
  }
  if (removedCount > 0) {
    void incrementStats(location.hostname, { cosmeticRemoved: removedCount });
  }
}

function startObserving(baseSelectors: string[], customSelectors: string[]): void {
  stopObserving();
  appliedCustomSelectors = customSelectors;
  const combinedBaseSelector = compileSelectorList(baseSelectors);
  const combinedCustomSelector = compileSelectorList(customSelectors);
  writePreHideCache(customSelectors);
  applyPreHideStyle(customSelectors);
  removeMatchesInDocument(combinedBaseSelector);
  removeMatchesInDocument(combinedCustomSelector);
  observer = new MutationObserver((mutations) => {
    removeMatchesInDocument(combinedBaseSelector);
    const addedNodes = mutations.flatMap((mutation) => Array.from(mutation.addedNodes));
    removeMatchesInAddedNodes(appliedCustomSelectors, addedNodes);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObserving(): void {
  observer?.disconnect();
  observer = null;
}

interface ResolvedSelectors {
  baseSelectors: string[];
  customSelectors: string[];
}

async function resolveSelectorsForDomain(hostname: string): Promise<ResolvedSelectors | null> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);

  if (!enabled) return null;

  const matchedPattern = findMatchingDomainPattern(hostname, Object.keys(domainRules));
  const entry = matchedPattern ? domainRules[matchedPattern] : undefined;

  if (entry?.allOff) return null;

  const disabled = entry ? new Set(entry.disabledSelectors) : null;
  const baseSelectors = disabled
    ? BASE_SELECTORS.filter((selector) => !disabled.has(selector))
    : BASE_SELECTORS;
  const customElements = await getCustomRemovedElements(hostname);
  return { baseSelectors, customSelectors: customElements.map((el) => el.selector) };
}

async function apply(): Promise<void> {
  reportHostname();

  const hostname = location.hostname;
  const resolved = await resolveSelectorsForDomain(hostname);

  if (resolved === null) {
    stopObserving();
    writePreHideCache([]);
    applyPreHideStyle([]);
    return;
  }

  startObserving(resolved.baseSelectors, resolved.customSelectors);
}

void apply();

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules || changes.customRemovedElements) {
    void apply();
  }
});

// document_start 로직이 다시 실행되지 않는 bfcache 복원 시 다시 검사한다.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    void apply();
  }
});

export {};
