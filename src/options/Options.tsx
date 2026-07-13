import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  clearCustomRemovedElementsForHostnames,
  clearDomainStatsForHostnames,
  getAllCustomRemovedElements,
  getDomainRules,
  getObservedRules,
  getStats,
  onStorageChange,
  removeCustomRemovedElement,
  removeDomainRule,
  setDomainRuleAllOff,
  toggleDisabledRuleId,
  upsertDomainRule,
  type AggregateStats,
  type CustomRemovedElement,
  type DiscoveredNetworkRule,
  type DomainRuleEntry,
} from "../lib/storage";
import { isValidDomainPattern, matchesDomainPattern } from "../lib/domain-matcher";
import filterMetadata from "../rules/filter-metadata.json";
import cosmeticSelectors from "../rules/cosmetic-selectors.json";
import packageJson from "../../package.json";

const COLORS = {
  bg: "#FAFAF9",
  card: "#FFFFFF",
  ink: "#18181B",
  sub: "#71717A",
  border: "#E4E4E7",
  borderSoft: "#F0F0F1",
  active: "#16A34A",
  activeSoft: "#EFFAF2",
  muted: "#A1A1AA",
  mutedSoft: "#F4F4F5",
  danger: "#DC2626",
  dangerSoft: "#FEF2F2",
  zebra: "#FAFAFA",
};

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <section
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
        padding: "20px 22px",
        marginBottom: 16,
        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" }}>{title}</h2>
      <p style={{ color: COLORS.sub, fontSize: 12.5, margin: 0, lineHeight: 1.6 }}>{description}</p>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      {label && <span style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.ink }}>{label}</span>}
      <span
        onClick={() => onChange(!checked)}
        style={{
          display: "inline-block",
          width: 38,
          height: 22,
          borderRadius: 11,
          background: checked ? COLORS.danger : COLORS.border,
          position: "relative",
          transition: "background 0.15s ease",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
            transition: "left 0.15s ease",
          }}
        />
      </span>
    </label>
  );
}

function ShortcutStatus() {
  const [shortcut, setShortcut] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void chrome.commands.getAll().then((commands) => {
      setShortcut(commands.find((c) => c.name === "toggle-element-picker")?.shortcut);
      setChecked(true);
    });
  }, []);

  const isAssigned = checked && !!shortcut;

  return (
    <Card
      style={{
        background: isAssigned ? COLORS.activeSoft : "#FFFBEB",
        border: `1px solid ${isAssigned ? "#16A34A33" : "#F59E0B44"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" }}>
            요소 선택기 단축키
          </h2>
          {!checked ? (
            <p style={{ color: COLORS.sub, fontSize: 12.5, margin: 0 }}>확인 중…</p>
          ) : isAssigned ? (
            <p style={{ fontSize: 13, margin: 0, color: COLORS.ink }}>
              현재 단축키:{" "}
              <code
                style={{
                  background: "#fff",
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontWeight: 700,
                }}
              >
                {shortcut}
              </code>
            </p>
          ) : (
            <p style={{ color: COLORS.sub, fontSize: 12.5, margin: 0, lineHeight: 1.6, maxWidth: 440 }}>
              단축키가 설정되어 있지 않습니다. Chrome/Whale 등 일부 브라우저는 확장 프로그램 단축키를
              자동으로 등록하지 않으므로, 아래 버튼으로 단축키 설정 페이지를 열어 직접 지정해야 합니다.
              (단축키 없이도 팝업의 &ldquo;요소 선택 시작&rdquo; 버튼은 항상 정상 작동합니다.)
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => chrome.tabs.create({ url: "chrome://extensions/shortcuts" })}
          style={{
            flexShrink: 0,
            padding: "8px 14px",
            borderRadius: 8,
            border: `1px solid ${COLORS.ink}`,
            background: COLORS.ink,
            color: "#fff",
            cursor: "pointer",
            fontSize: 12.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          단축키 설정 열기
        </button>
      </div>
    </Card>
  );
}

function AddPatternInput({ onAdd }: { onAdd: (pattern: string) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const handleAdd = useCallback(async () => {
    const pattern = draft.trim();
    if (!isValidDomainPattern(pattern)) {
      setError("도메인 패턴(와일드카드)을 입력하세요. 예: naver*.com");
      return;
    }
    setError(undefined);
    await onAdd(pattern);
    setDraft("");
  }, [draft, onAdd]);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder="도메인 패턴(와일드카드), 예: naver*.com"
          style={{
            flex: 1,
            padding: "8px 10px",
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            fontSize: 13,
            background: COLORS.bg,
            color: COLORS.ink,
          }}
        />
        <button
          type="button"
          onClick={handleAdd}
          style={{
            padding: "8px 18px",
            borderRadius: 8,
            border: `1px solid ${COLORS.ink}`,
            background: COLORS.ink,
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          추가
        </button>
      </div>
      {error && <p style={{ color: COLORS.danger, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
    </div>
  );
}

function ObservedRulesSubsection({
  observedRules,
  disabledRuleIds,
  onToggleRuleId,
  muted,
}: {
  observedRules: DiscoveredNetworkRule[];
  disabledRuleIds: number[];
  onToggleRuleId: (ruleId: number, disabled: boolean) => Promise<void>;
  muted: boolean;
}) {
  return (
    <div style={{ marginBottom: 16, opacity: muted ? 0.5 : 1 }}>
      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6, color: COLORS.ink }}>자동 차단 항목</div>
      {observedRules.length === 0 ? (
        <p style={{ color: COLORS.sub, fontSize: 12, margin: 0 }}>
          이 도메인 탭에서 팝업을 열면 실제 차단된 항목이 여기 표시됩니다.
        </p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {observedRules.map((rule, i) => {
              const isUnblocked = disabledRuleIds.includes(rule.ruleId);
              return (
                <tr key={rule.ruleId} style={{ background: i % 2 === 1 ? COLORS.zebra : "transparent" }}>
                  <td
                    style={{
                      padding: "6px 8px",
                      borderBottom: `1px solid ${COLORS.borderSoft}`,
                      fontFamily: "ui-monospace, monospace",
                      wordBreak: "break-all",
                    }}
                  >
                    {rule.description}
                  </td>
                  <td
                    style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, textAlign: "right", width: 60 }}
                  >
                    <ToggleSwitch
                      checked={isUnblocked}
                      onChange={(checked) => void onToggleRuleId(rule.ruleId, checked)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CustomElementsSubsection({
  hostnames,
  customElements,
  onRemove,
  muted,
}: {
  hostnames: string[];
  customElements: Record<string, CustomRemovedElement[]>;
  onRemove: (hostname: string, selector: string) => Promise<void>;
  muted: boolean;
}) {
  const relevantHostnames = useMemo(
    () => hostnames.filter((hostname) => (customElements[hostname]?.length ?? 0) > 0).sort(),
    [hostnames, customElements],
  );

  return (
    <div style={{ opacity: muted ? 0.5 : 1 }}>
      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6, color: COLORS.ink }}>수동 제거 항목</div>
      {relevantHostnames.length === 0 ? (
        <p style={{ color: COLORS.sub, fontSize: 12, margin: 0 }}>요소 선택기로 제거한 항목이 없습니다.</p>
      ) : (
        relevantHostnames.map((hostname) => {
          const elements = customElements[hostname] ?? [];
          return (
            <div key={hostname} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, marginBottom: 4, color: COLORS.sub, fontFamily: "ui-monospace, monospace" }}>
                {hostname}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {elements.map((el, i) => (
                    <tr key={el.selector} style={{ background: i % 2 === 1 ? COLORS.zebra : "transparent" }}>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, fontFamily: "ui-monospace, monospace" }}>
                        {el.selector}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, color: COLORS.sub, width: 140 }}>
                        {new Date(el.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, textAlign: "right", width: 70 }}>
                        <button
                          type="button"
                          onClick={() => onRemove(hostname, el.selector)}
                          style={{ border: "none", background: "transparent", color: COLORS.danger, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })
      )}
    </div>
  );
}

function DomainRuleCard({
  entry,
  observedRules,
  customElements,
  onSetAllOff,
  onDelete,
  onToggleRuleId,
  onRemoveCustomElement,
}: {
  entry: DomainRuleEntry;
  observedRules: Record<string, DiscoveredNetworkRule[]>;
  customElements: Record<string, CustomRemovedElement[]>;
  onSetAllOff: (pattern: string, allOff: boolean) => Promise<void>;
  onDelete: (pattern: string) => Promise<void>;
  onToggleRuleId: (pattern: string, ruleId: number, disabled: boolean) => Promise<void>;
  onRemoveCustomElement: (hostname: string, selector: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);

  const mergedObservedRules = useMemo(() => {
    const byId = new Map<number, DiscoveredNetworkRule>();
    for (const hostname of entry.knownHostnames) {
      for (const rule of observedRules[hostname] ?? []) {
        const existing = byId.get(rule.ruleId);
        if (!existing || existing.lastSeenAt < rule.lastSeenAt) {
          byId.set(rule.ruleId, rule);
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }, [entry.knownHostnames, observedRules]);

  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 10, marginBottom: 10, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 14px",
          background: entry.allOff ? COLORS.dangerSoft : COLORS.zebra,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, cursor: "pointer" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <span style={{ fontSize: 11, color: COLORS.sub, flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              fontWeight: 700,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {entry.pattern}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
          <ToggleSwitch checked={entry.allOff} onChange={(checked) => void onSetAllOff(entry.pattern, checked)} label="전체 끄기" />
          <button
            type="button"
            onClick={() => onDelete(entry.pattern)}
            style={{ border: "none", background: "transparent", color: COLORS.danger, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            삭제
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: "14px", background: COLORS.card }}>
          <ObservedRulesSubsection
            observedRules={mergedObservedRules}
            disabledRuleIds={entry.disabledRuleIds}
            onToggleRuleId={(ruleId, disabled) => onToggleRuleId(entry.pattern, ruleId, disabled)}
            muted={entry.allOff}
          />
          <CustomElementsSubsection
            hostnames={entry.knownHostnames.length > 0 ? entry.knownHostnames : [entry.pattern]}
            customElements={customElements}
            onRemove={onRemoveCustomElement}
            muted={entry.allOff}
          />
        </div>
      )}
    </div>
  );
}

export function Options() {
  const [domainRules, setDomainRulesState] = useState<Record<string, DomainRuleEntry>>({});
  const [observedRules, setObservedRulesState] = useState<Record<string, DiscoveredNetworkRule[]>>({});
  const [customElements, setCustomElements] = useState<Record<string, CustomRemovedElement[]>>({});
  const [stats, setStats] = useState<AggregateStats>({ totalNetworkBlocked: 0, totalCosmeticRemoved: 0, perDomain: {} });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [rules, observed, elements, aggregateStats] = await Promise.all([
      getDomainRules(),
      getObservedRules(),
      getAllCustomRemovedElements(),
      getStats(),
    ]);

    // 요소 선택기로 다룬 적이 있는 모든 호스트명은 관리 목록에 나타나야
    // 한다 — 아직 어떤 패턴도 매칭되지 않으면 정확한 호스트명 항목을 자동
    // 생성한다.
    let mergedRules = rules;
    const patterns = Object.keys(mergedRules);
    for (const hostname of Object.keys(elements)) {
      if ((elements[hostname]?.length ?? 0) === 0) continue;
      const hasMatch = patterns.some((pattern) => matchesDomainPattern(hostname, pattern));
      if (!hasMatch && !mergedRules[hostname]) {
        mergedRules = await upsertDomainRule(hostname);
      }
    }

    setDomainRulesState(mergedRules);
    setObservedRulesState(observed);
    setCustomElements(elements);
    setStats(aggregateStats);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    return onStorageChange(() => refresh());
  }, [refresh]);

  const networkRuleCount = filterMetadata.totalNetworkRules;
  const filterBuildDate = new Date(filterMetadata.generatedAt).toLocaleDateString();
  const cosmeticSelectorCount = Array.isArray(cosmeticSelectors) ? cosmeticSelectors.length : 0;
  const perDomainStats = useMemo(
    () =>
      Object.entries(stats.perDomain).sort(
        ([, a], [, b]) => b.networkBlocked + b.cosmeticRemoved - (a.networkBlocked + a.cosmeticRemoved),
      ),
    [stats],
  );

  const sortedPatterns = useMemo(() => Object.keys(domainRules).sort(), [domainRules]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.ink,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "36px 24px 60px" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, margin: "0 0 6px", letterSpacing: "-0.02em" }}>
            마! 치아라 <span style={{ color: COLORS.sub, fontWeight: 500 }}>· 설정</span>
          </h1>
          <p style={{ color: COLORS.sub, margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            도메인 관리, 차단 통계, 필터 목록 정보를 한 곳에서 확인합니다.
          </p>
        </div>

        {loading ? (
          <p style={{ color: COLORS.sub }}>불러오는 중…</p>
        ) : (
          <>
            <ShortcutStatus />

            <Card>
              <SectionHeading
                title="도메인 관리"
                description="도메인 패턴(와일드카드)별로 차단 여부를 관리합니다. '전체 끄기'는 해당 도메인에서 확장 프로그램이 설치되지 않은 것처럼 모든 차단·제거를 비활성화합니다. 개별 항목은 실제로 차단/제거된 것 중에서만 선택적으로 다시 허용할 수 있습니다."
              />

              <AddPatternInput onAdd={async (pattern) => setDomainRulesState(await upsertDomainRule(pattern))} />

              {sortedPatterns.length === 0 ? (
                <p style={{ color: COLORS.sub, fontSize: 12.5, margin: "8px 0 0" }}>등록된 도메인이 없습니다.</p>
              ) : (
                <div style={{ marginTop: 12 }}>
                  {sortedPatterns.map((pattern) => (
                    <DomainRuleCard
                      key={pattern}
                      entry={domainRules[pattern]!}
                      observedRules={observedRules}
                      customElements={customElements}
                      onSetAllOff={async (p, allOff) => setDomainRulesState(await setDomainRuleAllOff(p, allOff))}
                      onDelete={async (p) => {
                        // 삭제 전에 이 항목의 알려진 호스트명(및 패턴 자체)에 대한
                        // customRemovedElements를 지운다 — 그렇지 않으면 다음
                        // 새로고침이 고아 항목으로 감지해 즉시 재생성해버린다.
                        const entryBeingDeleted = domainRules[p];
                        const hostnamesToClear = entryBeingDeleted
                          ? [...new Set([...entryBeingDeleted.knownHostnames, p])]
                          : [p];
                        const nextElements = await clearCustomRemovedElementsForHostnames(hostnamesToClear);
                        setCustomElements(nextElements);
                        setStats(await clearDomainStatsForHostnames(hostnamesToClear));
                        setDomainRulesState(await removeDomainRule(p));
                      }}
                      onToggleRuleId={async (p, ruleId, disabled) =>
                        setDomainRulesState(await toggleDisabledRuleId(p, ruleId, disabled))
                      }
                      onRemoveCustomElement={async (hostname, selector) => {
                        const next = await removeCustomRemovedElement(hostname, selector);
                        setCustomElements((prev) => ({ ...prev, [hostname]: next }));
                      }}
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <SectionHeading
                title="차단 통계 (추정치)"
                description="Manifest V3는 배포 빌드에서 탭별 정확한 차단 요청 수를 제공하지 않으므로, 아래 수치는 최선의 추정치입니다."
              />
              <div style={{ display: "flex", gap: 12, marginBottom: perDomainStats.length > 0 ? 18 : 0 }}>
                <div style={{ flex: 1, background: COLORS.bg, border: `1px solid ${COLORS.borderSoft}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "ui-monospace, monospace", lineHeight: 1 }}>
                    ~{stats.totalNetworkBlocked.toLocaleString()}
                  </div>
                  <div style={{ color: COLORS.sub, fontSize: 11.5, marginTop: 5 }}>총 네트워크 요청 차단</div>
                </div>
                <div style={{ flex: 1, background: COLORS.bg, border: `1px solid ${COLORS.borderSoft}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "ui-monospace, monospace", lineHeight: 1 }}>
                    ~{stats.totalCosmeticRemoved.toLocaleString()}
                  </div>
                  <div style={{ color: COLORS.sub, fontSize: 11.5, marginTop: 5 }}>총 콘텐츠 요소 제거</div>
                </div>
              </div>

              {perDomainStats.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.sub, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        도메인
                      </th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.sub, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        네트워크 차단 (~)
                      </th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.sub, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        콘텐츠 제거 (~)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {perDomainStats.map(([hostname, domainStats], i) => (
                      <tr key={hostname} style={{ background: i % 2 === 1 ? COLORS.zebra : "transparent" }}>
                        <td style={{ padding: "7px 8px", borderBottom: `1px solid ${COLORS.borderSoft}` }}>{hostname}</td>
                        <td style={{ padding: "7px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                          {domainStats.networkBlocked.toLocaleString()}
                        </td>
                        <td style={{ padding: "7px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>
                          {domainStats.cosmeticRemoved.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card style={{ background: COLORS.zebra, marginBottom: 0 }}>
              <SectionHeading
                title="필터 목록"
                description="빌드 시점에 EasyList/EasyPrivacy에서 번들됩니다. 필터 목록은 자동으로 업데이트되지 않으며, 새로 고치려면 확장 프로그램을 다시 빌드해야 합니다 (npm run build:filters)."
              />
              <table style={{ fontSize: 13 }}>
                <tbody>
                  <tr>
                    <td style={{ padding: "3px 12px 3px 0", color: COLORS.sub }}>확장 프로그램 버전</td>
                    <td style={{ fontFamily: "ui-monospace, monospace" }}>{packageJson.version}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "3px 12px 3px 0", color: COLORS.sub }}>번들된 네트워크(DNR) 규칙 수</td>
                    <td style={{ fontFamily: "ui-monospace, monospace" }}>{networkRuleCount.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "3px 12px 3px 0", color: COLORS.sub }}>번들된 콘텐츠 선택자 수</td>
                    <td style={{ fontFamily: "ui-monospace, monospace" }}>{cosmeticSelectorCount.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "3px 12px 3px 0", color: COLORS.sub }}>필터 목록 빌드 날짜</td>
                    <td style={{ fontFamily: "ui-monospace, monospace" }}>{filterBuildDate}</td>
                  </tr>
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
