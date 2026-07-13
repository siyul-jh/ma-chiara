// 요소 선택기 콘텐츠 스크립트.
//
// "toggle-element-picker" 단축키(Alt+Shift+P, manifest.ts 참고)와 팝업의
// "요소 선택 시작" 버튼으로 토글된다. chrome.commands.onCommand는 백그라운드
// 서비스 워커에서만 발생하므로, 워커가 런타임 메시지
// ({ type: "toggle-element-picker" })를 활성 탭에 전달하고 여기서 수신한다.
// 팝업은 같은 메시지 타입을 직접 보낸다.
//
// 활성화되면 마우스를 올린 요소를 강조하고, 클릭하면 :nth-child() 경로
// 선택자로 즉시 제거 후 호스트명 키로 저장한다. 이후 페이지 로드 시 이
// 호스트명의 저장된 선택자는 매칭되는 DomainRuleEntry가 allOff가 아닌 모든
// 도메인에서 자동으로 다시 적용된다 — 재방문 시 기억하는 것이 기본 동작이다.

import {
  addCustomRemovedElement,
  createDomainRuleEntry,
  getCustomRemovedElements,
  getDomainRules,
  getEnabled,
  incrementStats,
  type DomainRuleEntry,
} from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const HIGHLIGHT_OUTLINE = "2px solid #ff4d4f";
const OVERLAY_ID = "__ma-chiara-element-picker-overlay__";

/**
 * document.body부터 명시적 :nth-child() 경로로 선택자를 만든다. finder류의
 * 축약 선택자와 달리, 동일한 클래스를 가진 반복 광고 슬롯 템플릿이라도 이
 * 정확한 DOM 위치에 대해 항상 고유하다 — 형제 요소와 우연히 매칭될 클래스/
 * id/태그 휴리스틱이 필요 없다. 클릭 시점엔 고유하던 축약 선택자가 이후
 * 비동기 로딩된 거의 동일한 광고 슬롯과 매칭되어 엉뚱한 요소를 지우는 문제를
 * 피하기 위해 의도적으로 가장 짧은 선택자를 쓰지 않는다.
 */
function buildNthChildPathSelector(element: Element): string {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && current.parentElement) {
    const parent: Element = current.parentElement;
    const index = Array.prototype.indexOf.call(parent.children, current) + 1;
    segments.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
    current = parent;
  }
  return `body > ${segments.join(" > ")}`;
}

let pickerActive = false;
let hoveredElement: Element | null = null;
let previousOutline = "";
let overlayEl: HTMLDivElement | null = null;

function isOwnUi(element: Element): boolean {
  return element.id === OVERLAY_ID || Boolean(element.closest(`#${OVERLAY_ID}`));
}

function clearHighlight(): void {
  if (hoveredElement instanceof HTMLElement) {
    hoveredElement.style.outline = previousOutline;
  }
  hoveredElement = null;
  previousOutline = "";
}

function highlight(element: Element): void {
  if (element === hoveredElement) return;
  clearHighlight();
  if (element instanceof HTMLElement) {
    previousOutline = element.style.outline;
    element.style.outline = HIGHLIGHT_OUTLINE;
  }
  hoveredElement = element;
}

function onMouseMove(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || isOwnUi(target)) return;
  highlight(target);
}

async function removeSelectorFromDom(selector: string): Promise<void> {
  let elements: NodeListOf<Element>;
  try {
    elements = document.querySelectorAll(selector);
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
    await incrementStats(location.hostname, { cosmeticRemoved: removedCount });
  }
}

async function matchingEntry(): Promise<DomainRuleEntry | undefined> {
  const domainRules = await getDomainRules();
  const matchedPattern = findMatchingDomainPattern(location.hostname, Object.keys(domainRules));
  return matchedPattern ? domainRules[matchedPattern] : undefined;
}

async function onClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof Element) || isOwnUi(target)) return;

  event.preventDefault();
  event.stopPropagation();

  clearHighlight();

  let selector: string;
  try {
    selector = buildNthChildPathSelector(target);
  } catch {
    deactivatePicker();
    return;
  }

  await addCustomRemovedElement(location.hostname, selector);
  // 이 호스트명이 Options 관리 목록에 나타나도록, 아직 매칭되는 패턴이
  // 없으면 정확한 호스트명 항목을 자동 생성한다.
  const domainRules = await getDomainRules();
  if (!findMatchingDomainPattern(location.hostname, Object.keys(domainRules))) {
    const entry: DomainRuleEntry = {
      ...createDomainRuleEntry(location.hostname),
      knownHostnames: [location.hostname],
    };
    const next = { ...domainRules, [location.hostname]: entry };
    await chrome.storage.local.set({ domainRules: next });
  }
  await removeSelectorFromDom(selector);
  deactivatePicker();
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    deactivatePicker();
  }
}

function mountOverlay(): void {
  if (overlayEl) return;
  overlayEl = document.createElement("div");
  overlayEl.id = OVERLAY_ID;
  overlayEl.style.position = "fixed";
  overlayEl.style.top = "12px";
  overlayEl.style.right = "12px";
  overlayEl.style.zIndex = "2147483647";
  overlayEl.style.padding = "8px 12px";
  overlayEl.style.background = "#1f1f1f";
  overlayEl.style.color = "#fff";
  overlayEl.style.fontFamily = "system-ui, sans-serif";
  overlayEl.style.fontSize = "13px";
  overlayEl.style.borderRadius = "6px";
  overlayEl.style.boxShadow = "0 2px 8px rgba(0,0,0,0.3)";
  overlayEl.style.pointerEvents = "none";
  overlayEl.textContent = "요소 선택기: 제거할 요소를 클릭하세요 (Esc로 취소)";
  document.documentElement.appendChild(overlayEl);
}

function unmountOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
}

function activatePicker(): void {
  if (pickerActive) return;
  pickerActive = true;
  mountOverlay();
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
}

function deactivatePicker(): void {
  if (!pickerActive) return;
  pickerActive = false;
  clearHighlight();
  unmountOverlay();
  document.removeEventListener("mousemove", onMouseMove, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKeyDown, true);
}

function togglePicker(): void {
  if (pickerActive) {
    deactivatePicker();
  } else {
    activatePicker();
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type !== "toggle-element-picker") return;
  // allOff/비활성화된 도메인은 확장 프로그램이 설치되지 않은 것처럼 동작해야
  // 하므로, 선택기도 여기서 활성화되어서는 안 된다.
  void (async () => {
    const [enabled, entry] = await Promise.all([getEnabled(), matchingEntry()]);
    if (!enabled || entry?.allOff) {
      deactivatePicker();
      return;
    }
    togglePicker();
  })();
});

async function reapplyPersistedSelectors(): Promise<void> {
  const [enabled, entry] = await Promise.all([getEnabled(), matchingEntry()]);
  if (!enabled || entry?.allOff) {
    return;
  }
  const customElements = await getCustomRemovedElements(location.hostname);
  for (const { selector } of customElements) {
    await removeSelectorFromDom(selector);
  }
}

void reapplyPersistedSelectors();

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    void reapplyPersistedSelectors();
  }
});

export {};
