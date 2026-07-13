import { useCallback, useEffect, useState } from "react";
import {
  getDomainRules,
  getDomainStats,
  getEnabled,
  onStorageChange,
  setEnabled,
  setObservedRules,
  type DiscoveredNetworkRule,
  type DomainStats,
} from "../lib/storage";
import { findMatchingDomainPattern } from "../lib/domain-matcher";

const COLORS = {
  bg: "#FAFAF9",
  ink: "#18181B",
  sub: "#71717A",
  border: "#E4E4E7",
  active: "#16A34A",
  activeSoft: "#EFFAF2",
  muted: "#A1A1AA",
  mutedSoft: "#F4F4F5",
};

interface CurrentSite {
  hostname: string;
  tabId: number | undefined;
}

async function getCurrentSite(): Promise<CurrentSite | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return undefined;
  try {
    const hostname = new URL(tab.url).hostname;
    if (!hostname) return undefined;
    return { hostname, tabId: tab.id };
  } catch {
    return undefined;
  }
}

async function startElementPicker(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, { type: "toggle-element-picker" });
  window.close();
}

interface RuleCondition {
  regexFilter?: string;
  urlFilter?: string;
  description: string;
}

// rule-conditions.json은 3만 개 이상의 규칙(~2.3MB)을 담고 있어, 클릭해서
// 여는 팝업에서 최상위 정적 import로 받아들일 수 없다. 실제로 필요할 때만
// 동적 import로 지연 로딩한다.
async function loadRuleConditions(): Promise<Record<string, RuleCondition>> {
  const mod = await import("../rules/rule-conditions.json");
  return mod.default as Record<string, RuleCondition>;
}

/**
 * 이 탭에서 Chrome이 실제로 매칭시킨 네트워크 규칙을 조회하고(활성 상태가
 * 아닌 문서는 최근 5분까지만 — 받아들인 제약), rule-conditions.json으로
 * 레이블을 붙여 Options 페이지가 읽을 발견 캐시에 저장한다. 실패해도 팝업이
 * 망가지지 않도록 감싼다.
 */
async function discoverMatchedRules(tabId: number | undefined, hostname: string): Promise<void> {
  if (tabId === undefined) return;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
    const ruleConditions = await loadRuleConditions();
    const now = Date.now();
    const byId = new Map<number, DiscoveredNetworkRule>();
    for (const info of rulesMatchedInfo) {
      const ruleId = info.rule.ruleId;
      const condition = ruleConditions[String(ruleId)];
      byId.set(ruleId, {
        ruleId,
        description: condition?.description ?? String(ruleId),
        lastSeenAt: now,
      });
    }
    await setObservedRules(hostname, [...byId.values()]);
  } catch {
    // getMatchedRules는 권한 부족 등으로 예외를 던질 수 있음 — 무시.
  }
}

export function Popup() {
  const [site, setSite] = useState<CurrentSite | undefined>(undefined);
  const [enabled, setEnabledState] = useState(true);
  const [allOff, setAllOff] = useState(false);
  const [stats, setStats] = useState<DomainStats>({ networkBlocked: 0, cosmeticRemoved: 0 });
  const [loading, setLoading] = useState(true);
  const [shortcut, setShortcut] = useState<string>("");

  const refresh = useCallback(async () => {
    const [currentSite, isEnabled, domainRules, commands] = await Promise.all([
      getCurrentSite(),
      getEnabled(),
      getDomainRules(),
      chrome.commands.getAll(),
    ]);
    setSite(currentSite);
    setEnabledState(isEnabled);
    const matchedPattern = currentSite
      ? findMatchingDomainPattern(currentSite.hostname, Object.keys(domainRules))
      : undefined;
    setAllOff(matchedPattern ? Boolean(domainRules[matchedPattern]?.allOff) : false);
    setShortcut(commands.find((c) => c.name === "toggle-element-picker")?.shortcut ?? "");
    if (currentSite) {
      setStats(await getDomainStats(currentSite.hostname));
      // Options 페이지를 위해, Chrome이 이 탭에서 실제로 차단한 것을 새로 발견한다.
      await discoverMatchedRules(currentSite.tabId, currentSite.hostname);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    return onStorageChange(() => refresh());
  }, [refresh]);

  const handleToggleEnabled = useCallback(async () => {
    await setEnabled(!enabled);
    setEnabledState(!enabled);
  }, [enabled]);

  const approxBlocked = stats.networkBlocked + stats.cosmeticRemoved;
  const siteActive = enabled && !allOff;
  const statusColor = allOff ? COLORS.muted : siteActive ? COLORS.active : COLORS.muted;
  const statusSoft = allOff ? COLORS.mutedSoft : siteActive ? COLORS.activeSoft : COLORS.mutedSoft;

  return (
    <div
      style={{
        width: 300,
        background: COLORS.bg,
        color: COLORS.ink,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
        fontSize: 13,
      }}
    >
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}` }}>
        <h1 style={{ fontSize: 14, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>
          마! 치아라 <span style={{ color: COLORS.sub, fontWeight: 400 }}>· 광고 제거기</span>
        </h1>
      </div>

      {loading ? (
        <p style={{ color: COLORS.sub, padding: "16px" }}>불러오는 중…</p>
      ) : (
        <div style={{ padding: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              background: statusSoft,
              border: `1px solid ${statusColor}22`,
              borderRadius: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {site?.hostname ?? "이 사이트"}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 3 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: statusColor,
                    flexShrink: 0,
                  }}
                />
                <span style={{ color: statusColor, fontSize: 11, fontWeight: 600 }}>
                  {allOff ? "전체 끄기 — 차단 비활성화" : siteActive ? "보호 작동 중" : "확장 프로그램 꺼짐"}
                </span>
              </div>
            </div>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                cursor: "pointer",
                flexShrink: 0,
                marginLeft: 8,
              }}
            >
              <input
                type="checkbox"
                checked={enabled}
                onChange={handleToggleEnabled}
                style={{ width: 18, height: 18, accentColor: COLORS.active, cursor: "pointer" }}
              />
            </label>
          </div>

          <div
            style={{
              padding: "14px 14px",
              marginBottom: 12,
              borderRadius: 10,
              background: COLORS.ink,
              color: "#fff",
            }}
            title="추정치입니다 — Chrome Manifest V3 API는 프로덕션 빌드에서 탭별 정확한 차단 요청 수를 제공하지 않습니다."
          >
            <div
              style={{
                fontSize: 26,
                fontWeight: 800,
                fontFamily: "'SF Mono', ui-monospace, Menlo, monospace",
                lineHeight: 1,
                letterSpacing: "-0.01em",
              }}
            >
              ~{approxBlocked.toLocaleString()}
            </div>
            <div style={{ color: "#A1A1AA", fontSize: 11, marginTop: 5 }}>이 사이트에서 차단됨 (추정치)</div>
          </div>

          <button
            type="button"
            onClick={() => startElementPicker(site?.tabId)}
            disabled={!site || allOff}
            style={{
              width: "100%",
              padding: "9px 10px",
              marginBottom: 4,
              borderRadius: 8,
              border: `1px solid ${site && !allOff ? COLORS.ink : COLORS.border}`,
              background: site && !allOff ? COLORS.ink : COLORS.mutedSoft,
              color: site && !allOff ? "#fff" : COLORS.muted,
              cursor: site && !allOff ? "pointer" : "not-allowed",
              fontSize: 13,
              fontWeight: 600,
              transition: "opacity 0.12s ease",
            }}
          >
            요소 선택 시작
          </button>
          <div style={{ color: COLORS.sub, fontSize: 10.5, margin: "0 0 10px", lineHeight: 1.5 }}>
            단축키({shortcut || "미설정"})가 안 되면 이 버튼을 사용하세요. 단축키 설정은 설정 페이지에서
            확인할 수 있습니다.
          </div>

          <button
            type="button"
            onClick={() => chrome.runtime.openOptionsPage()}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: "transparent",
              color: COLORS.ink,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            설정 열기
          </button>
        </div>
      )}
    </div>
  );
}
