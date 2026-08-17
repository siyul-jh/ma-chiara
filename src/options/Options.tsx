import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  clearCustomRemovedElementsForHostnames,
  clearDomainStatsForHostnames,
  getAllCustomRemovedElements,
  getDomainRules,
  getEnabled,
  getFilterUpdate,
  getObservedRules,
  getStats,
  onStorageChange,
  removeCustomRemovedElement,
  removeDomainRule,
  renameDomainRule,
  setDomainRuleAllOff,
  setEnabled,
  toggleDisabledRuleId,
  upsertDomainRule,
  type AggregateStats,
  type CustomRemovedElement,
  type DiscoveredNetworkRule,
  type DomainRuleEntry,
  type FilterUpdateState,
} from "../lib/storage";
import { isValidDomainPattern, matchesDomainPattern, suggestWildcardPattern } from "../lib/domain-matcher";
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

/**
 * React 이벤트 핸들러는 반환된 프로미스를 무시하므로, async 핸들러가 실패하면
 * 처리되지 않은 거부로 남는다. 저장 실패를 조용히 흘려보내지 않도록 감싼다.
 */
function runAction(action: Promise<unknown>): void {
  void action.catch((error: unknown) => {
    console.error("[마! 치아라] 설정을 저장하지 못했습니다.", error);
  });
}

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

// 기본 tone은 danger — "차단 해제"처럼 켜짐이 개별 예외를 뜻하는 스위치용.
// "사용 중" 자체를 뜻하는 스위치(전역 사용, 도메인별 사용)는 켜짐=보호
// 작동 중(기본값)이 정상이므로 active를 쓴다.
function ToggleSwitch({
  checked,
  onChange,
  label,
  tone = "danger",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  tone?: "danger" | "active";
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
          background: checked ? (tone === "active" ? COLORS.active : COLORS.danger) : COLORS.border,
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
    let cancelled = false;
    void (async () => {
      const commands = await chrome.commands.getAll();
      if (cancelled) return;
      setShortcut(commands.find((c) => c.name === "toggle-element-picker")?.shortcut);
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
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

function FilterUpdateStatus() {
  const [state, setState] = useState<FilterUpdateState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await getFilterUpdate();
      if (!cancelled) setState(current);
    })();
    return onStorageChange((changes) => {
      if (changes.filterUpdate) {
        void getFilterUpdate().then((current) => setState(current));
      }
    });
  }, []);

  const handleUpdate = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const outcome: unknown = await chrome.runtime.sendMessage({ type: "update-filters" });
      setMessage(
        outcome === "updated"
          ? "필터 목록을 갱신했습니다."
          : outcome === "unchanged"
            ? "이미 최신 상태입니다."
            : "갱신에 실패했습니다. 네트워크 상태를 확인해 주세요.",
      );
    } catch {
      setMessage("갱신에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, []);

  const addedCount = state?.addedGenericSelectors.length ?? 0;
  const domainCount = state ? Object.keys(state.domainSelectors).length : 0;

  return (
    <div
      style={{
        marginTop: 14,
        paddingTop: 14,
        borderTop: `1px solid ${COLORS.border}`,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 4 }}>코스메틱 필터 자동 갱신</div>
        <p style={{ color: COLORS.sub, fontSize: 11.5, margin: 0, lineHeight: 1.6, maxWidth: 460 }}>
          {state === undefined
            ? "확인 중…"
            : state === null
              ? "아직 갱신한 적이 없습니다. 하루 한 번 자동으로 확인하며, 그전까지는 번들된 필터를 사용합니다."
              : `최종 갱신 ${new Date(state.updatedAt).toLocaleString()} · 도메인 ${domainCount.toLocaleString()}개, 새 범용 선택자 ${addedCount.toLocaleString()}개`}
        </p>
        {message && (
          <p style={{ color: COLORS.sub, fontSize: 11.5, margin: "6px 0 0" }}>{message}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => runAction(handleUpdate())}
        disabled={busy}
        style={{
          flexShrink: 0,
          padding: "7px 12px",
          borderRadius: 8,
          border: `1px solid ${busy ? COLORS.border : COLORS.ink}`,
          background: busy ? COLORS.mutedSoft : "transparent",
          color: busy ? COLORS.muted : COLORS.ink,
          cursor: busy ? "not-allowed" : "pointer",
          fontSize: 12,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "갱신 중…" : "지금 갱신"}
      </button>
    </div>
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
            if (e.key === "Enter") runAction(handleAdd());
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
          onClick={() => runAction(handleAdd())}
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
                      onChange={(checked) => runAction(onToggleRuleId(rule.ruleId, checked))}
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

interface CustomElementRow {
  hostname: string;
  selector: string;
  createdAt: number;
}

// customRemovedElements는 실제로 골랐던 리터럴 호스트명별로 저장되므로,
// entry.knownHostnames 전체를 하나의 목록으로 합쳐서 보여준다(카드 제목이
// 이미 현재 패턴을 보여준다). 출처가 둘 이상일 때만 행마다 호스트명을 덧붙인다.
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
  const rows = useMemo(() => {
    const flattened: CustomElementRow[] = [];
    for (const hostname of hostnames) {
      for (const el of customElements[hostname] ?? []) {
        flattened.push({ hostname, selector: el.selector, createdAt: el.createdAt });
      }
    }
    return flattened.sort((a, b) => b.createdAt - a.createdAt);
  }, [hostnames, customElements]);

  const showOrigin = new Set(rows.map((row) => row.hostname)).size > 1;

  return (
    <div style={{ opacity: muted ? 0.5 : 1 }}>
      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6, color: COLORS.ink }}>수동 제거 항목</div>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.sub, fontSize: 12, margin: 0 }}>요소 선택기로 제거한 항목이 없습니다.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.hostname}::${row.selector}`} style={{ background: i % 2 === 1 ? COLORS.zebra : "transparent" }}>
                <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, fontFamily: "ui-monospace, monospace" }}>
                  {row.selector}
                  {showOrigin && (
                    <div style={{ color: COLORS.sub, fontSize: 10.5, marginTop: 2, fontWeight: 400 }}>{row.hostname}</div>
                  )}
                </td>
                <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, color: COLORS.sub, width: 140 }}>
                  {new Date(row.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: "6px 8px", borderBottom: `1px solid ${COLORS.borderSoft}`, textAlign: "right", width: 70 }}>
                  <button
                    type="button"
                    onClick={() => runAction(onRemove(row.hostname, row.selector))}
                    style={{ border: "none", background: "transparent", color: COLORS.danger, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
  onConvertToWildcard,
}: {
  entry: DomainRuleEntry;
  observedRules: Record<string, DiscoveredNetworkRule[]>;
  customElements: Record<string, CustomRemovedElement[]>;
  onSetAllOff: (pattern: string, allOff: boolean) => Promise<void>;
  onDelete: (pattern: string) => Promise<void>;
  onToggleRuleId: (pattern: string, ruleId: number, disabled: boolean) => Promise<void>;
  onRemoveCustomElement: (hostname: string, selector: string) => Promise<void>;
  onConvertToWildcard: (oldPattern: string, newPattern: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingPattern, setEditingPattern] = useState(false);
  const [draftPattern, setDraftPattern] = useState(entry.pattern);
  const [patternError, setPatternError] = useState<string | undefined>(undefined);

  const isWildcard = entry.pattern.includes("*");

  const startEditingPattern = useCallback(() => {
    setDraftPattern(suggestWildcardPattern(entry.pattern));
    setPatternError(undefined);
    setEditingPattern(true);
  }, [entry.pattern]);

  const cancelEditingPattern = useCallback(() => {
    setEditingPattern(false);
    setPatternError(undefined);
  }, []);

  const applySuffixWildcard = useCallback(() => {
    setDraftPattern((current) => suggestWildcardPattern(current, { wildcardSuffix: true }));
  }, []);

  const confirmEditingPattern = useCallback(async () => {
    const next = draftPattern.trim();
    if (!isValidDomainPattern(next)) {
      setPatternError("올바른 도메인 패턴을 입력하세요. 예: naver*.com");
      return;
    }
    if (next === entry.pattern) {
      setEditingPattern(false);
      return;
    }
    await onConvertToWildcard(entry.pattern, next);
    setEditingPattern(false);
  }, [draftPattern, entry.pattern, onConvertToWildcard]);

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
        {editingPattern ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
            <input
              type="text"
              value={draftPattern}
              onChange={(e) => setDraftPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runAction(confirmEditingPattern());
                if (e.key === "Escape") cancelEditingPattern();
              }}
              autoFocus
              style={{
                flex: 1,
                minWidth: 0,
                padding: "5px 8px",
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                fontSize: 12.5,
                fontFamily: "ui-monospace, monospace",
                background: "#fff",
                color: COLORS.ink,
              }}
            />
            <button
              type="button"
              onClick={applySuffixWildcard}
              title="최상위 도메인(.com/.net 등)까지 와일드카드로 바꿉니다"
              style={{
                border: `1px solid ${COLORS.border}`,
                background: "transparent",
                color: COLORS.ink,
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                padding: "5px 8px",
                borderRadius: 6,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              .com/.net도
            </button>
            <button
              type="button"
              onClick={() => runAction(confirmEditingPattern())}
              style={{
                border: `1px solid ${COLORS.ink}`,
                background: COLORS.ink,
                color: "#fff",
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 10px",
                borderRadius: 6,
                flexShrink: 0,
              }}
            >
              저장
            </button>
            <button
              type="button"
              onClick={cancelEditingPattern}
              style={{
                border: `1px solid ${COLORS.border}`,
                background: "transparent",
                color: COLORS.sub,
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 10px",
                borderRadius: 6,
                flexShrink: 0,
              }}
            >
              취소
            </button>
          </div>
        ) : (
          <>
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
              {!isWildcard && (
                <button
                  type="button"
                  onClick={startEditingPattern}
                  title="같은 사이트가 번호나 접미사만 바꿔 옮겨 다니는 미러 도메인(예: naver43.com → naver46.com)에도 이 규칙과 수동 제거 항목이 자동 적용되도록 와일드카드 패턴으로 바꿉니다."
                  style={{
                    border: `1px solid ${COLORS.border}`,
                    background: "transparent",
                    color: COLORS.ink,
                    cursor: "pointer",
                    fontSize: 11.5,
                    fontWeight: 600,
                    padding: "4px 9px",
                    borderRadius: 6,
                    whiteSpace: "nowrap",
                  }}
                >
                  와일드카드로 변경
                </button>
              )}
              <ToggleSwitch
                checked={!entry.allOff}
                onChange={(checked) => runAction(onSetAllOff(entry.pattern, !checked))}
                label="이 도메인에서 사용"
                tone="active"
              />
              <button
                type="button"
                onClick={() => runAction(onDelete(entry.pattern))}
                style={{ border: "none", background: "transparent", color: COLORS.danger, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                삭제
              </button>
            </div>
          </>
        )}
      </div>

      {editingPattern && patternError && (
        <div style={{ padding: "0 14px 10px", fontSize: 11.5, color: COLORS.danger, background: COLORS.zebra }}>
          {patternError}
        </div>
      )}

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
  const [enabled, setEnabledState] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [rules, observed, elements, aggregateStats, isEnabled] = await Promise.all([
      getDomainRules(),
      getObservedRules(),
      getAllCustomRemovedElements(),
      getStats(),
      getEnabled(),
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
    setEnabledState(isEnabled);
    setLoading(false);
  }, []);

  const handleToggleEnabled = useCallback(async (next: boolean) => {
    await setEnabled(next);
    setEnabledState(next);
  }, []);

  useEffect(() => {
    refresh();
    return onStorageChange(() => refresh());
  }, [refresh]);

  // 번들된 규칙 중 실제로 몇 개가 켜졌는지는 브라우저마다 다르다 — 보장분을
  // 넘는 룰셋은 다른 확장 프로그램과 나눠 쓰는 전역 풀에서 가져오기 때문이다.
  const [activeNetworkRules, setActiveNetworkRules] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
      if (cancelled) return;
      const counts: readonly number[] = filterMetadata.rulesetRuleCounts;
      const total = enabledRulesets.reduce((sum, id) => {
        const index = Number(id.replace("ruleset-", "")) - 1;
        return sum + (counts[index] ?? 0);
      }, 0);
      setActiveNetworkRules(total);
    })();
    return () => {
      cancelled = true;
    };
  }, [domainRules]);

  const networkRuleCount = filterMetadata.totalNetworkRules;
  const filterBuildDate = new Date(filterMetadata.generatedAt).toLocaleDateString();
  const cosmeticSelectorCount = Array.isArray(cosmeticSelectors) ? cosmeticSelectors.length : 0;
  const perDomainStats = useMemo(
    () =>
      Object.entries(stats.perDomain)
        .filter(([, domainStats]) => domainStats.cosmeticRemoved > 0)
        .sort(([, a], [, b]) => b.cosmeticRemoved - a.cosmeticRemoved),
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
            <Card
              style={{
                background: enabled ? COLORS.activeSoft : COLORS.dangerSoft,
                border: `1px solid ${enabled ? "#16A34A33" : "#DC262633"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <h2 style={{ fontSize: 15, fontWeight: 700, margin: "0 0 4px", letterSpacing: "-0.01em" }}>
                    확장 프로그램 사용
                  </h2>
                  <p style={{ color: COLORS.sub, fontSize: 12.5, margin: 0, lineHeight: 1.6, maxWidth: 460 }}>
                    끄면 모든 사이트에서 차단·제거와 스크롤 잠금 해제가 중단됩니다. 특정 사이트에서만 끄려면
                    아래 도메인 관리에서 그 도메인의 &ldquo;이 도메인에서 사용&rdquo; 스위치를 꺼 주세요.
                  </p>
                </div>
                <div style={{ flexShrink: 0, paddingTop: 2 }}>
                  <ToggleSwitch checked={enabled} onChange={(checked) => runAction(handleToggleEnabled(checked))} tone="active" />
                </div>
              </div>
            </Card>

            <ShortcutStatus />

            <Card>
              <SectionHeading
                title="도메인 관리"
                description="도메인 패턴(와일드카드)별로 차단 여부를 관리합니다. '이 도메인에서 사용'을 끄면 해당 도메인에서 확장 프로그램이 설치되지 않은 것처럼 모든 차단·제거를 비활성화합니다(기본값은 켜짐입니다). 개별 항목은 실제로 차단/제거된 것 중에서만 선택적으로 다시 허용할 수 있습니다."
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
                      onConvertToWildcard={async (oldPattern, newPattern) => {
                        setDomainRulesState(await renameDomainRule(oldPattern, newPattern));
                      }}
                    />
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <SectionHeading
                title="차단 통계"
                description="숨긴 광고 요소의 누적 개수입니다. 네트워크 요청 차단 수는 별도로 표시하지 않습니다 — 아래 설명을 참고하세요."
              />
              <div style={{ display: "flex", gap: 12, marginBottom: perDomainStats.length > 0 ? 18 : 0 }}>
                <div style={{ flex: 1, background: COLORS.bg, border: `1px solid ${COLORS.borderSoft}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "ui-monospace, monospace", lineHeight: 1 }}>
                    {stats.totalCosmeticRemoved.toLocaleString()}
                  </div>
                  <div style={{ color: COLORS.sub, fontSize: 11.5, marginTop: 5 }}>총 숨긴 광고 요소</div>
                </div>
                <div style={{ flex: 1, background: COLORS.bg, border: `1px solid ${COLORS.borderSoft}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "ui-monospace, monospace", lineHeight: 1, color: COLORS.muted }}>
                    —
                  </div>
                  <div style={{ color: COLORS.sub, fontSize: 11.5, marginTop: 5 }}>네트워크 요청 차단 (측정 불가)</div>
                </div>
              </div>

              <p style={{ color: COLORS.sub, fontSize: 11.5, margin: perDomainStats.length > 0 ? "0 0 14px" : 0, lineHeight: 1.6 }}>
                네트워크 차단은 Chrome이 확장 프로그램 코드를 거치지 않고 직접 처리하므로(declarativeNetRequest),
                배포 빌드에서는 몇 건이 차단됐는지 셀 수 있는 방법이 없습니다. 차단 자체는 정상 동작하며, 실제로
                어떤 요청이 걸렸는지는 위 도메인 관리의 &ldquo;자동 차단 항목&rdquo;에서 확인할 수 있습니다.
              </p>

              {perDomainStats.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.sub, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        도메인
                      </th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${COLORS.border}`, padding: "6px 8px", color: COLORS.sub, fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.02em" }}>
                        숨긴 광고 요소
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {perDomainStats.map(([hostname, domainStats], i) => (
                      <tr key={hostname} style={{ background: i % 2 === 1 ? COLORS.zebra : "transparent" }}>
                        <td style={{ padding: "7px 8px", borderBottom: `1px solid ${COLORS.borderSoft}` }}>{hostname}</td>
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
                    <td style={{ padding: "3px 12px 3px 0", color: COLORS.sub }}>현재 활성 규칙 수</td>
                    <td style={{ fontFamily: "ui-monospace, monospace" }}>
                      {activeNetworkRules === undefined ? "확인 중…" : activeNetworkRules.toLocaleString()}
                    </td>
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

              <FilterUpdateStatus />
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
