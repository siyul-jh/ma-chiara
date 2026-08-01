// 백그라운드 서비스 워커.
//
// 1. 정적 DNR 룰셋은 manifest.ts에 이미 선언되어 Chrome이 자동 로드하므로,
//    여기서는 전역 온/오프에 따라 활성/비활성만 유지한다.
// 2. 통합 도메인 규칙 목록(domainRules)을 네트워크 계층에서 강제 적용한다.
//    각 항목은 도메인 전체를 끄거나(allOff) 개별 네트워크 규칙 ID를 차단
//    해제할 수 있다. 둘 다 condition.initiatorDomains(요청 URL이 아니라
//    "요청을 시작한 페이지"와 매칭 — DNR의 규칙 조건 문서 참고)를 그 항목이
//    발견한 리터럴 호스트명(knownHostnames) 대상으로 하는 높은 우선순위
//    세션 allow 규칙으로 표현한다. initiatorDomains는 와일드카드를 받지
//    않으므로, 콘텐츠 스크립트의 자가 보고를 거쳐 리터럴 호스트명을 채운다
//    (handleReportedHostname). 세션 규칙은 디스크에 저장되지 않으므로 워커
//    시작마다, 그리고 domainRules/enabled 변경마다 스토리지로부터 다시 만든다.
// 3. "toggle-element-picker" 단축키를 활성 탭의 콘텐츠 스크립트로 전달한다.
// 4. 최선-노력 차단 개수를 보고한다. onRuleMatchedDebug는 언패킹/개발
//    모드에서만 존재하므로, 프로덕션 개수는 콘텐츠 스크립트가 관찰한
//    콘텐츠 제거 내역에서 가져온다.

import {
  addKnownHostname,
  getDomainRules,
  getEnabled,
  getFilterUpdate,
  incrementStats,
  onStorageChange,
  type DomainRuleEntry,
} from "../lib/storage";
import { runFilterUpdate } from "./filter-update";
import { matchesDomainPattern } from "../lib/domain-matcher";
import { collectDomainSelectors } from "../lib/cosmetic-domain-lookup";
import { sendToggleElementPicker } from "../lib/element-picker-injector";
import filterMetadata from "../rules/filter-metadata.json";

interface RuleCondition {
  regexFilter?: string;
  urlFilter?: string;
  description: string;
}

// 규칙 조건/설명은 전량 9MB라 룰셋과 같은 경계로 쪼개 두었다. 규칙 ID가
// 순번이므로 필요한 조각만 골라 읽는다 — 실제로 필요한 경우는 개별 차단
// 해제 규칙을 다시 만들 때와 팝업이 매칭된 규칙에 이름을 붙일 때뿐이다.
const ruleConditionChunks = new Map<number, Promise<Record<string, RuleCondition>>>();

function loadRuleConditionChunk(chunkIndex: number): Promise<Record<string, RuleCondition>> {
  let cached = ruleConditionChunks.get(chunkIndex);
  if (!cached) {
    cached = import(`../rules/rule-conditions-${chunkIndex + 1}.json`).then(
      (mod: { default: Record<string, RuleCondition> }) => mod.default,
    );
    ruleConditionChunks.set(chunkIndex, cached);
  }
  return cached;
}

/** 팝업에 넘길 사람이 읽을 수 있는 이름. 원본 필터 라인이 없으면 조건식으로 대체한다. */
function toRuleDescriptions(conditions: Map<number, RuleCondition>): Record<number, string> {
  const descriptions: Record<number, string> = {};
  for (const [id, condition] of conditions) {
    descriptions[id] = condition.description || condition.regexFilter || condition.urlFilter || String(id);
  }
  return descriptions;
}

/** 필요한 조각만 읽어 규칙 ID → 조건 맵을 만든다. */
async function getRuleConditions(ruleIds: readonly number[]): Promise<Map<number, RuleCondition>> {
  const perChunk = filterMetadata.rulesPerRulesetFile;
  const neededChunks = new Set(ruleIds.map((id) => Math.floor((id - 1) / perChunk)));
  const result = new Map<number, RuleCondition>();

  await Promise.all(
    [...neededChunks]
      .filter((index) => index >= 0 && index < filterMetadata.rulesetFileCount)
      .map(async (index) => {
        const chunk = await loadRuleConditionChunk(index);
        for (const id of ruleIds) {
          const condition = chunk[String(id)];
          if (condition) result.set(id, condition);
        }
      }),
  );

  return result;
}

// 도메인 특화 코스메틱 선택자 맵(~520KB). 콘텐츠 스크립트에 넣으면 프레임마다
// 파싱해야 하므로, 탭 전체가 공유하는 이 워커가 한 번만 읽어 들고 조회해준다.
let domainCosmeticsPromise: Promise<Record<string, string[]>> | undefined;
function loadDomainCosmetics(): Promise<Record<string, string[]>> {
  if (!domainCosmeticsPromise) {
    domainCosmeticsPromise = import("../rules/cosmetic-domains.json").then(
      (mod) => mod.default as Record<string, string[]>,
    );
  }
  return domainCosmeticsPromise;
}

const RULESET_IDS = Array.from(
  { length: filterMetadata.rulesetFileCount },
  (_, index) => `ruleset-${index + 1}`,
);
// 매니페스트에서 이미 켜진 채로 배포되는, 보장 최소치 안의 룰셋들.
const CORE_RULESET_IDS = RULESET_IDS.slice(0, filterMetadata.coreRulesetCount);
// 전역 풀 가용량이 허락할 때만 켜는 나머지. 못 켜도 핵심 차단은 동작한다.
const EXTENDED_RULESET_IDS = RULESET_IDS.slice(filterMetadata.coreRulesetCount);
const RULESET_RULE_COUNTS: readonly number[] = filterMetadata.rulesetRuleCounts;
const ALLOW_RULE_ID_START = 1;
const ALLOW_RULE_PRIORITY = 1000;

async function buildAllowRules(
  domainRules: Record<string, DomainRuleEntry>,
): Promise<chrome.declarativeNetRequest.Rule[]> {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let nextId = ALLOW_RULE_ID_START;

  const neededRuleIds = Object.values(domainRules)
    .filter((entry) => !entry.allOff && entry.knownHostnames.length > 0)
    .flatMap((entry) => entry.disabledRuleIds);
  const ruleConditions =
    neededRuleIds.length > 0 ? await getRuleConditions(neededRuleIds) : new Map<number, RuleCondition>();

  for (const entry of Object.values(domainRules)) {
    if (entry.knownHostnames.length === 0) continue;

    if (entry.allOff) {
      rules.push({
        id: nextId++,
        priority: ALLOW_RULE_PRIORITY,
        action: { type: "allow" },
        condition: { initiatorDomains: entry.knownHostnames },
      });
      continue;
    }

    for (const ruleId of entry.disabledRuleIds) {
      const condition = ruleConditions.get(ruleId);
      if (!condition) continue;
      const matchCondition: chrome.declarativeNetRequest.RuleCondition = {
        initiatorDomains: entry.knownHostnames,
      };
      if (condition.regexFilter) {
        matchCondition.regexFilter = condition.regexFilter;
      } else if (condition.urlFilter) {
        matchCondition.urlFilter = condition.urlFilter;
      }
      rules.push({
        id: nextId++,
        priority: ALLOW_RULE_PRIORITY,
        action: { type: "allow" },
        condition: matchCondition,
      });
    }
  }

  return rules;
}

/**
 * 보장 최소치를 넘는 룰셋을 전역 풀에서 확보할 수 있는 만큼 켠다.
 *
 * 가용량은 브라우저에 설치된 다른 확장 프로그램이 정적 규칙을 얼마나 쓰는지에
 * 달려 있어 빌드 시점에는 알 수 없다. 남은 예산을 물어보고 들어가는 것만
 * 켜되, 그 사이 상황이 바뀔 수 있으므로 하나씩 켜다가 실패하면 거기서 멈춘다
 * — 일부만 켜져도 그만큼은 차단된다.
 *
 * 켜진 상태는 브라우저 재시작 후에도 유지되므로 보통 한 번만 수렴한다.
 */
async function enableExtendedRulesets(alreadyEnabled: readonly string[]): Promise<void> {
  const enabledSet = new Set(alreadyEnabled);
  const pending = EXTENDED_RULESET_IDS.filter((id) => !enabledSet.has(id));
  if (pending.length === 0) return;

  let available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();

  for (const id of pending) {
    const cost = RULESET_RULE_COUNTS[RULESET_IDS.indexOf(id)] ?? 0;
    if (cost === 0 || cost > available) break;
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
    } catch {
      break; // 전역 풀 소진 — 여기까지가 이 브라우저에서 가능한 최대치다.
    }
    available -= cost;
  }
}

async function syncStaticRulesets(enabled: boolean): Promise<void> {
  const currentlyEnabled = await chrome.declarativeNetRequest.getEnabledRulesets();

  if (!enabled) {
    if (currentlyEnabled.length > 0) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: currentlyEnabled });
    }
    return;
  }

  const missingCore = CORE_RULESET_IDS.filter((id) => !currentlyEnabled.includes(id));
  if (missingCore.length > 0) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: missingCore });
  }

  await enableExtendedRulesets([...currentlyEnabled, ...missingCore]);
}

// 정적 룰셋 토글과 세션 예외 규칙은 서로 독립적이므로 따로 감싼다. 한쪽이
// 실패해도 다른 쪽은 적용되어야 하고, 무엇보다 실패가 처리되지 않은 프로미스
// 거부로 새어나가면 chrome://extensions에 원인을 알 수 없는 오류로만 뜬다.
async function syncNetworkRules(): Promise<void> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);

  try {
    await syncStaticRulesets(enabled);
  } catch (error) {
    console.error(
      "[마! 치아라] 정적 차단 룰셋을 적용하지 못했습니다. 광고 차단이 동작하지 않습니다.",
      error,
    );
  }

  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const addRules = enabled ? await buildAllowRules(domainRules) : [];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules,
    });
  } catch (error) {
    console.error(
      "[마! 치아라] 도메인별 차단 해제 규칙을 적용하지 못했습니다. 설정한 예외가 " +
        "동작하지 않습니다.",
      error,
    );
  }
}

/** 모든 호출 지점이 void로 부르므로, 여기서 나머지 실패까지 흡수한다. */
function runSyncNetworkRules(): void {
  void syncNetworkRules().catch((error: unknown) => {
    console.error("[마! 치아라] 차단 규칙 동기화에 실패했습니다.", error);
  });
}

async function handleReportedHostname(hostname: string): Promise<void> {
  if (!hostname) return;
  const domainRules = await getDomainRules();
  let changed = false;
  for (const entry of Object.values(domainRules)) {
    if (entry.knownHostnames.includes(hostname)) continue;
    if (matchesDomainPattern(hostname, entry.pattern)) {
      await addKnownHostname(entry.pattern, hostname);
      changed = true;
    }
  }
  if (changed) {
    await syncNetworkRules();
  }
}

// 통계 갱신은 읽기-수정-쓰기라 동시에 실행되면 유실된다. 탭이 여러 개 열려
// 있어도 이 워커는 하나뿐이므로, 모든 갱신을 여기로 모아 프로미스 체인으로
// 직렬화한다.
let statsWriteChain: Promise<unknown> = Promise.resolve();

function enqueueCosmeticCount(hostname: string, count: number): void {
  // 체인은 반드시 catch로 끝나야 한다. 마지막 갱신이 실패한 채로 남으면 뒤에
  // 이어붙는 호출이 없어 처리되지 않은 거부가 되고, 통계 실패가 확장 프로그램
  // 전체의 오류로 보고된다.
  statsWriteChain = statsWriteChain
    .then(() => incrementStats(hostname, { cosmeticRemoved: count }))
    .catch((error: unknown) => {
      console.error("[마! 치아라] 차단 통계를 갱신하지 못했습니다.", error);
    });
}

/**
 * 이 호스트명에 적용할 코스메틱 선택자. 번들된 도메인 맵에 런타임 갱신본을
 * 덧씌운다. 갱신본에는 도메인 규칙과 함께 "번들에 없던 새 범용 선택자"도
 * 들어 있는데, 범용 스타일시트는 콘텐츠 스크립트가 첫 페인트 전에 동기로
 * 붙이는 터라 그쪽 경로를 건드릴 수 없기 때문이다.
 */
async function collectCosmeticsForHost(hostname: string): Promise<string[]> {
  const bundled = await loadDomainCosmetics();
  const selectors = new Set(collectDomainSelectors(hostname, bundled));

  const update = await getFilterUpdate();
  if (update) {
    for (const selector of collectDomainSelectors(hostname, update.domainSelectors)) {
      selectors.add(selector);
    }
    for (const selector of update.addedGenericSelectors) {
      selectors.add(selector);
    }
  }

  return [...selectors];
}

// 하루 한 번 상류 필터 목록을 확인한다. EasyList는 하루 몇 차례 갱신되지만,
// 조건부 요청이라 변경이 없으면 본문을 받지 않으므로 이 주기로 충분하다.
const FILTER_UPDATE_ALARM = "ma-chiara-filter-update";
const FILTER_UPDATE_PERIOD_MINUTES = 60 * 24;

function runFilterUpdateInBackground(options: { force?: boolean } = {}): void {
  void runFilterUpdate(options).catch((error: unknown) => {
    console.error("[마! 치아라] 필터 목록 갱신에 실패했습니다.", error);
  });
}

async function ensureFilterUpdateAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(FILTER_UPDATE_ALARM);
  if (!existing) {
    await chrome.alarms.create(FILTER_UPDATE_ALARM, {
      periodInMinutes: FILTER_UPDATE_PERIOD_MINUTES,
      delayInMinutes: 1,
    });
  }
}

async function relayToggleElementPicker(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === undefined) return;
  try {
    await sendToggleElementPicker(activeTab.id);
  } catch {
    // 정말로 주입 불가능한 탭 (예: chrome:// 페이지) — 무시.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  runSyncNetworkRules();
  void ensureFilterUpdateAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  runSyncNetworkRules();
  void ensureFilterUpdateAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FILTER_UPDATE_ALARM) {
    runFilterUpdateInBackground();
  }
});

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules) {
    runSyncNetworkRules();
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; hostname?: string; count?: number; ruleIds?: unknown[] },
    _sender,
    sendResponse,
  ) => {
    if (message?.type === "report-hostname" && typeof message.hostname === "string") {
      void handleReportedHostname(message.hostname).catch((error: unknown) => {
        console.error("[마! 치아라] 호스트명을 등록하지 못했습니다.", error);
      });
      return false;
    }
    if (
      message?.type === "report-cosmetic-count" &&
      typeof message.hostname === "string" &&
      typeof message.count === "number" &&
      message.count > 0
    ) {
      enqueueCosmeticCount(message.hostname, message.count);
      return false;
    }
    if (message?.type === "update-filters") {
      // 설정 페이지의 수동 갱신. 조건부 요청을 건너뛰고 강제로 다시 받는다.
      void runFilterUpdate({ force: true }).then(
        (outcome) => sendResponse(outcome),
        () => sendResponse("failed"),
      );
      return true;
    }
    if (message?.type === "describe-rules" && Array.isArray(message.ruleIds)) {
      const ruleIds = message.ruleIds.filter((id): id is number => typeof id === "number");
      // 팝업이 직접 읽기에는 조건 데이터가 너무 크다. 필요한 조각만 여기서 읽어
      // 설명 문자열만 돌려준다.
      void getRuleConditions(ruleIds).then(
        (conditions) => sendResponse(toRuleDescriptions(conditions)),
        () => sendResponse({}),
      );
      return true;
    }
    if (message?.type === "get-domain-cosmetics" && typeof message.hostname === "string") {
      const hostname = message.hostname;
      // 응답이 비동기이므로 true를 반환해 메시지 채널을 열어둔다. 실패해도
      // 콘텐츠 스크립트가 무한정 기다리지 않도록 빈 배열로 답한다.
      void collectCosmeticsForHost(hostname).then(
        (selectors) => sendResponse(selectors),
        () => sendResponse([]),
      );
      return true;
    }
    return false;
  },
);

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-element-picker") {
    void relayToggleElementPicker().catch((error: unknown) => {
      console.error("[마! 치아라] 요소 선택기를 전달하지 못했습니다.", error);
    });
  }
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    void chrome.action
      .setBadgeText({
        tabId: info.request.tabId >= 0 ? info.request.tabId : undefined,
        text: "•",
      })
      // 탭이 이미 닫혔으면 실패한다 — 배지는 부가 정보이므로 조용히 넘긴다.
      .catch(() => undefined);
  });
}

runSyncNetworkRules();
