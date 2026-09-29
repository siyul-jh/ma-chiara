// 우클릭·드래그·복사 금지 해제 콘텐츠 스크립트. 도메인 규칙의 copyUnlock을 켠 사이트에서만 동작한다
// (자체 우클릭 메뉴를 쓰는 웹앱이 깨질 수 있어 기본은 꺼짐).
//
// 사이트는 보통 document/body에 contextmenu·selectstart·copy 핸들러를 달고 preventDefault()로 막는다.
// window의 캡처 단계는 그 어떤 리스너보다 먼저 실행되므로, 여기서 전파만 끊으면 사이트 핸들러가
// 불리지 않고 브라우저 기본 동작(메뉴 표시, 선택, 복사)은 그대로 일어난다. 복사할 때 "출처"를
// 덧붙이는 스크립트도 같은 이유로 막힌다. CSS user-select: none은 스타일로 되돌린다.
//
// 입력창·편집기 안의 이벤트는 건드리지 않는다 — 편집기는 복사·붙여넣기를 직접 처리하는 경우가 많다.
// 붙여넣기(paste)는 막는 사이트가 드물고 끊으면 댓글 편집기가 깨지므로 대상에서 뺐다.
// ponytail: mousedown에서 선택을 막는 사이트는 풀지 못한다. mousedown 전파를 끊으면 거의 모든 사이트가 깨진다.

import { getDomainRules, getEnabled, onStorageChange } from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const BLOCKED_EVENTS = ["contextmenu", "selectstart", "dragstart", "copy", "cut"] as const;
const CLIPBOARD_KEYS = new Set(["a", "c", "x"]);
const STYLE_ID = "ma-chiara-copy-unlock";
const UNLOCK_CSS = "html, body, body * { -webkit-user-select: text !important; user-select: text !important; }";

let active = false;

function isEditable(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

function stopSiteHandlers(event: Event): void {
  if (!active || isEditable(event.target)) return;
  event.stopImmediatePropagation();
}

// Ctrl/Cmd+A·C·X를 keydown에서 가로채 막는 사이트용. 다른 키는 건드리지 않는다.
function stopClipboardShortcut(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || !CLIPBOARD_KEYS.has(event.key.toLowerCase())) return;
  stopSiteHandlers(event);
}

// 리스너는 document_start에 바로 등록해 둔다. 켜짐 여부는 저장소를 읽은 뒤 active로 정한다.
for (const type of BLOCKED_EVENTS) {
  window.addEventListener(type, stopSiteHandlers, true);
}
window.addEventListener("keydown", stopClipboardShortcut, true);

function setUnlockStyle(on: boolean): void {
  const existing = document.getElementById(STYLE_ID);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = UNLOCK_CSS;
  (document.head ?? document.documentElement).append(style);
}

async function apply(): Promise<void> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);
  const matchedPattern = findMatchingDomainPattern(location.hostname, Object.keys(domainRules));
  const entry = matchedPattern ? domainRules[matchedPattern] : undefined;
  active = enabled && !entry?.allOff && Boolean(entry?.copyUnlock);
  setUnlockStyle(active);
}

function runApply(): void {
  void apply().catch((error: unknown) => {
    console.error("[마! 치아라] 복사 금지 해제를 적용하지 못했습니다.", error);
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
