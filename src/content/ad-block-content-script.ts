// 콘텐츠(광고) 숨김 콘텐츠 스크립트. document_start 시점에 SW를 거치지
// 않고 chrome.storage.local을 직접 읽는다 (SW 콜드 스타트 경쟁 상태 회피).
//
// 숨김은 MutationObserver가 아니라 <style> 주입으로 처리한다. CSS 엔진이
// 매칭을 네이티브로, 변경된 부분에 대해서만 수행하므로 DOM이 끊임없이 바뀌는
// 페이지에서도 메인 스레드를 점유하지 않는다. 요소는 제거되는 대신
// display:none으로 숨겨진다.

import cosmeticCss from "../rules/cosmetic.css?raw";
import {
  getCustomRemovedElements,
  getDomainRules,
  getEnabled,
  onStorageChange,
} from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const BASE_STYLE_ID = "__ma-chiara-cosmetic-style__";
const DOMAIN_STYLE_ID = "__ma-chiara-domain-style__";
const CUSTOM_STYLE_ID = "__ma-chiara-pre-hide-style__";

/** scripts/build-filter-rules.ts의 CSS_SELECTORS_PER_RULE과 맞춰야 한다. */
const BASE_SELECTORS_PER_RULE = 64;

// storage 읽기는 비동기라 첫 페인트 전에는 결과를 알 수 없다. 마지막 상태를
// localStorage(동기)에 캐시해 재방문 시의 깜빡임을 없앤다.
const CUSTOM_CACHE_KEY = "__ma-chiara-custom-selectors-cache__";
const DOMAIN_CACHE_KEY = "__ma-chiara-domain-selectors-cache__";
const ACTIVE_CACHE_KEY = "__ma-chiara-active-cache__";

function readCache(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 용량 초과, 서드파티 스토리지 차단 등 — 최선-노력.
  }
}

function readSelectorCache(key: string): string[] {
  const raw = readCache(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/**
 * batchSize를 키우면 선언부 중복이 줄어 스타일시트가 작아지지만, 문법이 잘못된
 * 선택자 하나가 같은 묶음의 나머지까지 함께 버려지게 만든다.
 */
function toCss(selectors: readonly string[], batchSize = 1): string {
  const rules: string[] = [];
  for (let i = 0; i < selectors.length; i += batchSize) {
    rules.push(`${selectors.slice(i, i + batchSize).join(",")}{display:none!important}`);
  }
  return rules.join("\n");
}

function setStyle(id: string, cssText: string): void {
  let styleEl = document.getElementById(id) as HTMLStyleElement | null;
  if (!cssText) {
    styleEl?.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = id;
    // document_start에는 head가 아직 없을 수 있다.
    (document.head ?? document.documentElement).appendChild(styleEl);
  }
  if (styleEl.textContent !== cssText) {
    styleEl.textContent = cssText;
  }
}

// 캐시가 없으면 "동작 중"으로 간주한다 — allOff는 명시적으로 켜는 예외다.
if (readCache(ACTIVE_CACHE_KEY) !== "0") {
  setStyle(BASE_STYLE_ID, cosmeticCss);
  setStyle(DOMAIN_STYLE_ID, toCss(readSelectorCache(DOMAIN_CACHE_KEY)));
  setStyle(CUSTOM_STYLE_ID, toCss(readSelectorCache(CUSTOM_CACHE_KEY)));
}

// 하위 프레임은 보고하지 않는다: 이 호스트명은 DNR initiatorDomains("요청을
// 시작한 페이지")로 쓰이므로 애초에 맞는 값이 아니고, 프레임마다 보내면 광고
// iframe이 많은 페이지에서 SW를 수십 번 깨운다.
/**
 * 서비스 워커로 보내되 실패는 삼킨다. sendMessage는 확장 프로그램 컨텍스트가
 * 무효화되면 동기적으로 던지고, 워커가 응답하지 않으면 프로미스로 거부한다 —
 * 동기 try/catch만으로는 후자를 잡지 못해 처리되지 않은 거부로 남는다.
 */
function sendToWorker(message: Record<string, unknown>): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // 확장 프로그램이 업데이트·재시작되어 컨텍스트가 사라진 경우 — 최선-노력.
  }
}

function reportHostname(): void {
  if (window.top !== window) return;
  sendToWorker({ type: "report-hostname", hostname: location.hostname });
}

/** 개별 선택자를 다시 허용한 도메인에서만 선택자 JSON을 읽어 다시 만든다. */
async function buildBaseCss(disabledSelectors: readonly string[]): Promise<string> {
  if (disabledSelectors.length === 0) return cosmeticCss;
  const disabled = new Set(disabledSelectors);
  const mod = await import("../rules/cosmetic-selectors.json");
  const selectors = mod.default as string[];
  return toCss(selectors.filter((selector) => !disabled.has(selector)), BASE_SELECTORS_PER_RULE);
}

// 도메인 특화 선택자는 서비스 워커에 물어본다 — 맵이 520KB라 프레임마다 들고
// 있을 수 없다. 응답을 기다리는 사이 첫 페인트가 지나가므로 받은 목록을
// 캐시해, 다음 방문에는 스크립트 평가 즉시 적용되게 한다. 최상위 프레임만
// 갱신하며, 같은 출처의 하위 프레임은 공유된 localStorage 캐시로 함께 적용된다.
async function applyDomainCosmetics(disabledSelectors: readonly string[]): Promise<void> {
  if (window.top !== window) return;
  let selectors: string[];
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: "get-domain-cosmetics",
      hostname: location.hostname,
    });
    if (!Array.isArray(response)) return;
    selectors = response.filter((s): s is string => typeof s === "string");
  } catch {
    return; // SW 재시작 등 — 캐시본을 그대로 둔다.
  }
  const disabled = new Set(disabledSelectors);
  const effective = disabled.size > 0 ? selectors.filter((s) => !disabled.has(s)) : selectors;
  writeCache(DOMAIN_CACHE_KEY, JSON.stringify(effective));
  setStyle(DOMAIN_STYLE_ID, toCss(effective));
}

function runWhenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => task(), { timeout: 5000 });
  } else {
    window.setTimeout(task, 3000);
  }
}

// 숨김을 CSS에 맡기면 몇 개를 가렸는지 알 수 없다. 통계는 UI 전반에서 추정치로
// 표기되므로 유휴 시간 및 DOMContentLoaded 시점에 최상위 프레임에서 안전하게 세어 보고한다.
let hiddenCountScheduled = false;

function countHiddenElements(): void {
  if (window.top !== window) return;
  let hiddenCount = 0;
  for (const id of [BASE_STYLE_ID, DOMAIN_STYLE_ID, CUSTOM_STYLE_ID]) {
    const styleEl = document.getElementById(id) as HTMLStyleElement | null;
    if (!styleEl?.sheet) continue;
    try {
      for (const rule of styleEl.sheet.cssRules) {
        const { selectorText } = rule as CSSStyleRule;
        if (!selectorText) continue;
        try {
          hiddenCount += document.querySelectorAll(selectorText).length;
        } catch {
          // 단일 선택자 파싱 오류는 무시하고 나머지 규칙은 계속 계산한다.
        }
      }
    } catch {
      // CSSStyleSheet 접근 오류 방지
    }
  }

  if (hiddenCount > 0) {
    sendToWorker({
      type: "report-cosmetic-count",
      hostname: location.hostname,
      count: hiddenCount,
    });
  }
}

function scheduleHiddenCount(): void {
  if (hiddenCountScheduled || window.top !== window) return;
  hiddenCountScheduled = true;

  const runCount = () => {
    countHiddenElements();
  };

  runWhenIdle(() => {
    runCount();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", runCount, { once: true });
    }
  });
}

interface ResolvedStyles {
  baseCss: string;
  customSelectors: string[];
  disabledSelectors: readonly string[];
}

async function resolveStylesForDomain(hostname: string): Promise<ResolvedStyles | null> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);

  if (!enabled) return null;

  const matchedPattern = findMatchingDomainPattern(hostname, Object.keys(domainRules));
  const entry = matchedPattern ? domainRules[matchedPattern] : undefined;

  if (entry?.allOff) return null;

  const disabledSelectors = entry?.disabledSelectors ?? [];
  const [baseCss, customElements] = await Promise.all([
    buildBaseCss(disabledSelectors),
    getCustomRemovedElements(hostname),
  ]);
  return { baseCss, customSelectors: customElements.map((el) => el.selector), disabledSelectors };
}

async function apply(): Promise<void> {
  reportHostname();

  const resolved = await resolveStylesForDomain(location.hostname);

  if (resolved === null) {
    writeCache(ACTIVE_CACHE_KEY, "0");
    writeCache(CUSTOM_CACHE_KEY, "[]");
    writeCache(DOMAIN_CACHE_KEY, "[]");
    setStyle(BASE_STYLE_ID, "");
    setStyle(DOMAIN_STYLE_ID, "");
    setStyle(CUSTOM_STYLE_ID, "");
    return;
  }

  writeCache(ACTIVE_CACHE_KEY, "1");
  writeCache(CUSTOM_CACHE_KEY, JSON.stringify(resolved.customSelectors));
  setStyle(BASE_STYLE_ID, resolved.baseCss);
  setStyle(CUSTOM_STYLE_ID, toCss(resolved.customSelectors));
  void applyDomainCosmetics(resolved.disabledSelectors).catch((error: unknown) => {
    console.error("[마! 치아라] 도메인별 광고 숨김 규칙을 적용하지 못했습니다.", error);
  });
  scheduleHiddenCount();
}

function runApply(): void {
  void apply().catch((error: unknown) => {
    console.error("[마! 치아라] 광고 숨김 스타일을 적용하지 못했습니다.", error);
  });
}

runApply();

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules || changes.customRemovedElements) {
    runApply();
  }
});

// document_start 로직이 다시 실행되지 않는 bfcache 복원 시 다시 검사한다.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    runApply();
  }
});
