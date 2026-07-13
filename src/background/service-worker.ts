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
  onStorageChange,
  type DomainRuleEntry,
} from "../lib/storage";
import { matchesDomainPattern } from "../lib/domain-matcher";

interface RuleCondition {
  regexFilter?: string;
  urlFilter?: string;
  description: string;
}

// rule-conditions.json은 번들된 네트워크 규칙 3만 개 이상(~2.3MB)을 다룬다.
// 최상위 정적 import 대신 지연 로딩해 SW가 깨어날 때마다 드는 스크립트
// 평가 비용을 낮춘다 — 실제로 필요한 시점은 개별 차단 해제된 규칙에 대한
// allow 규칙을 다시 만들 때뿐이다.
let ruleConditionsPromise: Promise<Record<string, RuleCondition>> | undefined;
function loadRuleConditions(): Promise<Record<string, RuleCondition>> {
  if (!ruleConditionsPromise) {
    ruleConditionsPromise = import("../rules/rule-conditions.json").then(
      (mod) => mod.default as Record<string, RuleCondition>,
    );
  }
  return ruleConditionsPromise;
}

const STATIC_RULESET_IDS = ["ruleset-1", "ruleset-2", "ruleset-3", "ruleset-4", "ruleset-5", "ruleset-6"];
const ALLOW_RULE_ID_START = 1;
const ALLOW_RULE_PRIORITY = 1000;

async function buildAllowRules(
  domainRules: Record<string, DomainRuleEntry>,
): Promise<chrome.declarativeNetRequest.Rule[]> {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let nextId = ALLOW_RULE_ID_START;

  const needsRuleConditions = Object.values(domainRules).some(
    (entry) => !entry.allOff && entry.disabledRuleIds.length > 0 && entry.knownHostnames.length > 0,
  );
  const ruleConditions = needsRuleConditions ? await loadRuleConditions() : {};

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
      const condition = ruleConditions[String(ruleId)];
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

async function syncNetworkRules(): Promise<void> {
  const [enabled, domainRules] = await Promise.all([getEnabled(), getDomainRules()]);

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enabled ? STATIC_RULESET_IDS : [],
    disableRulesetIds: enabled ? [] : STATIC_RULESET_IDS,
  });

  const addRules = enabled ? await buildAllowRules(domainRules) : [];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
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

async function relayToggleElementPicker(): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(activeTab.id, { type: "toggle-element-picker" });
  } catch {
    // 이 탭에 대기 중인 콘텐츠 스크립트 없음 (예: chrome:// 페이지) — 무시.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void syncNetworkRules();
});

chrome.runtime.onStartup.addListener(() => {
  void syncNetworkRules();
});

onStorageChange((changes) => {
  if (changes.enabled || changes.domainRules) {
    void syncNetworkRules();
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string; hostname?: string }) => {
  if (message?.type === "report-hostname" && typeof message.hostname === "string") {
    void handleReportedHostname(message.hostname);
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-element-picker") {
    void relayToggleElementPicker();
  }
});

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    void chrome.action.setBadgeText({
      tabId: info.request.tabId >= 0 ? info.request.tabId : undefined,
      text: "•",
    });
  });
}

void syncNetworkRules();

export {};
