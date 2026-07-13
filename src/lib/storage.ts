// chrome.storage.local을 감싸는 타입 래퍼. 전역 온/오프, 통합 도메인 규칙
// 목록(domainRules), 도메인별 수동 제거 요소, 팝업이 관찰한 네트워크 규칙
// 캐시(observedRules), 최선-노력 차단 통계를 다룬다.

export interface CustomRemovedElement {
  /** 요소 선택기가 생성한 CSS 선택자. */
  selector: string;
  createdAt: number;
}

/**
 * domainRules에 와일드카드 패턴(또는 정확한 호스트명)을 키로 저장되는
 * 통합 도메인 관리 항목.
 */
export interface DomainRuleEntry {
  /** 와일드카드 글롭 패턴 또는 정확한 호스트명. */
  pattern: string;
  /** "이 도메인에서 전부 끄기" 토글. */
  allOff: boolean;
  /** 사용자가 수동으로 차단 해제한 개별 네트워크(DNR) 규칙 ID들. */
  disabledRuleIds: number[];
  /** 사용자가 수동으로 다시 노출시킨 개별 콘텐츠 선택자들. */
  disabledSelectors: string[];
  /**
   * 콘텐츠 스크립트 자가 보고로 확인된, 이 패턴에 실제 매칭된 리터럴
   * 호스트명들 — DNR의 initiatorDomains는 와일드카드를 받지 않기 때문에 필요.
   */
  knownHostnames: string[];
}

/** 특정 탭에서 매칭된 것으로 관찰된 네트워크 규칙. 팝업이 열릴 때마다 새로고침. */
export interface DiscoveredNetworkRule {
  ruleId: number;
  /** 가능하면 사람이 읽을 수 있는 형태, 아니면 원본 regexFilter/urlFilter. */
  description: string;
  lastSeenAt: number;
}

export interface DomainStats {
  networkBlocked: number;
  cosmeticRemoved: number;
}

export interface AggregateStats {
  totalNetworkBlocked: number;
  totalCosmeticRemoved: number;
  perDomain: Record<string, DomainStats>;
}

export interface StorageSchema {
  enabled: boolean;
  domainRules: Record<string, DomainRuleEntry>;
  customRemovedElements: Record<string, CustomRemovedElement[]>;
  observedRules: Record<string, DiscoveredNetworkRule[]>;
  stats: AggregateStats;
}

const DEFAULTS: StorageSchema = {
  enabled: true,
  domainRules: {},
  customRemovedElements: {},
  observedRules: {},
  stats: {
    totalNetworkBlocked: 0,
    totalCosmeticRemoved: 0,
    perDomain: {},
  },
};

const KEYS = Object.keys(DEFAULTS) as (keyof StorageSchema)[];

async function getAll(): Promise<StorageSchema> {
  const stored = await chrome.storage.local.get<Partial<StorageSchema>>(KEYS);
  return {
    enabled: stored.enabled ?? DEFAULTS.enabled,
    domainRules: stored.domainRules ?? DEFAULTS.domainRules,
    customRemovedElements: stored.customRemovedElements ?? DEFAULTS.customRemovedElements,
    observedRules: stored.observedRules ?? DEFAULTS.observedRules,
    stats: stored.stats ?? DEFAULTS.stats,
  };
}

export async function getFullState(): Promise<StorageSchema> {
  return getAll();
}

export function onStorageChange(
  callback: (changes: Partial<Record<keyof StorageSchema, chrome.storage.StorageChange>>) => void,
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: chrome.storage.AreaName,
  ) => {
    if (areaName !== "local") return;
    const relevant: Partial<Record<keyof StorageSchema, chrome.storage.StorageChange>> = {};
    for (const key of KEYS) {
      if (key in changes) {
        relevant[key] = changes[key];
      }
    }
    if (Object.keys(relevant).length > 0) {
      callback(relevant);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// --- 전역 온/오프 ---

export async function getEnabled(): Promise<boolean> {
  const { enabled } = await chrome.storage.local.get<Partial<StorageSchema>>("enabled");
  return enabled ?? DEFAULTS.enabled;
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ enabled });
}

// --- 도메인 규칙 목록 ---

export function createDomainRuleEntry(pattern: string): DomainRuleEntry {
  return {
    pattern,
    allOff: false,
    disabledRuleIds: [],
    disabledSelectors: [],
    knownHostnames: [],
  };
}

export async function getDomainRules(): Promise<Record<string, DomainRuleEntry>> {
  const { domainRules } = await chrome.storage.local.get<Partial<StorageSchema>>("domainRules");
  return domainRules ?? DEFAULTS.domainRules;
}

export async function upsertDomainRule(pattern: string): Promise<Record<string, DomainRuleEntry>> {
  const domainRules = await getDomainRules();
  if (domainRules[pattern]) return domainRules;
  const next = { ...domainRules, [pattern]: createDomainRuleEntry(pattern) };
  await chrome.storage.local.set({ domainRules: next });
  return next;
}

export async function removeDomainRule(pattern: string): Promise<Record<string, DomainRuleEntry>> {
  const domainRules = await getDomainRules();
  if (!domainRules[pattern]) return domainRules;
  const next = { ...domainRules };
  delete next[pattern];
  await chrome.storage.local.set({ domainRules: next });
  return next;
}

async function updateDomainRule(
  pattern: string,
  mutate: (entry: DomainRuleEntry) => DomainRuleEntry,
): Promise<Record<string, DomainRuleEntry>> {
  const domainRules = await getDomainRules();
  const existing = domainRules[pattern] ?? createDomainRuleEntry(pattern);
  const next = { ...domainRules, [pattern]: mutate(existing) };
  await chrome.storage.local.set({ domainRules: next });
  return next;
}

export async function setDomainRuleAllOff(
  pattern: string,
  allOff: boolean,
): Promise<Record<string, DomainRuleEntry>> {
  return updateDomainRule(pattern, (entry) => ({ ...entry, allOff }));
}

export async function toggleDisabledRuleId(
  pattern: string,
  ruleId: number,
  disabled: boolean,
): Promise<Record<string, DomainRuleEntry>> {
  return updateDomainRule(pattern, (entry) => {
    const has = entry.disabledRuleIds.includes(ruleId);
    if (disabled === has) return entry;
    const disabledRuleIds = disabled
      ? [...entry.disabledRuleIds, ruleId]
      : entry.disabledRuleIds.filter((id) => id !== ruleId);
    return { ...entry, disabledRuleIds };
  });
}

export async function toggleDisabledSelector(
  pattern: string,
  selector: string,
  disabled: boolean,
): Promise<Record<string, DomainRuleEntry>> {
  return updateDomainRule(pattern, (entry) => {
    const has = entry.disabledSelectors.includes(selector);
    if (disabled === has) return entry;
    const disabledSelectors = disabled
      ? [...entry.disabledSelectors, selector]
      : entry.disabledSelectors.filter((s) => s !== selector);
    return { ...entry, disabledSelectors };
  });
}

export async function addKnownHostname(
  pattern: string,
  hostname: string,
): Promise<Record<string, DomainRuleEntry>> {
  const domainRules = await getDomainRules();
  const existing = domainRules[pattern];
  if (!existing || existing.knownHostnames.includes(hostname)) return domainRules;
  const next = {
    ...domainRules,
    [pattern]: { ...existing, knownHostnames: [...existing.knownHostnames, hostname] },
  };
  await chrome.storage.local.set({ domainRules: next });
  return next;
}

// --- 수동 제거 요소 (요소 선택기) ---

export async function getCustomRemovedElements(hostname: string): Promise<CustomRemovedElement[]> {
  const all = await getAllCustomRemovedElements();
  return all[hostname] ?? [];
}

export async function getAllCustomRemovedElements(): Promise<Record<string, CustomRemovedElement[]>> {
  const { customRemovedElements } =
    await chrome.storage.local.get<Partial<StorageSchema>>("customRemovedElements");
  return customRemovedElements ?? DEFAULTS.customRemovedElements;
}

export async function addCustomRemovedElement(
  hostname: string,
  selector: string,
): Promise<CustomRemovedElement[]> {
  const all = await getAllCustomRemovedElements();
  const existing = all[hostname] ?? [];
  if (existing.some((el) => el.selector === selector)) return existing;
  const next = [...existing, { selector, createdAt: Date.now() }];
  const updated: Record<string, CustomRemovedElement[]> = { ...all, [hostname]: next };
  await chrome.storage.local.set({ customRemovedElements: updated });
  return next;
}

export async function removeCustomRemovedElement(
  hostname: string,
  selector: string,
): Promise<CustomRemovedElement[]> {
  const all = await getAllCustomRemovedElements();
  const existing = all[hostname] ?? [];
  const next = existing.filter((el) => el.selector !== selector);
  const updated: Record<string, CustomRemovedElement[]> = { ...all, [hostname]: next };
  await chrome.storage.local.set({ customRemovedElements: updated });
  return next;
}

/**
 * DomainRuleEntry 삭제 시 함께 호출한다 — 그렇지 않으면 남은
 * customRemovedElements가 다음 새로고침에서 고아 항목으로 감지되어 방금
 * 삭제한 항목을 자동으로 재생성해버린다.
 */
export async function clearCustomRemovedElementsForHostnames(
  hostnames: readonly string[],
): Promise<Record<string, CustomRemovedElement[]>> {
  const all = await getAllCustomRemovedElements();
  const updated = { ...all };
  let changed = false;
  for (const hostname of hostnames) {
    if (hostname in updated) {
      delete updated[hostname];
      changed = true;
    }
  }
  if (changed) {
    await chrome.storage.local.set({ customRemovedElements: updated });
  }
  return updated;
}

// --- 관찰된 네트워크 규칙 캐시 (휘발성) ---

export async function getObservedRules(): Promise<Record<string, DiscoveredNetworkRule[]>> {
  const { observedRules } = await chrome.storage.local.get<Partial<StorageSchema>>("observedRules");
  return observedRules ?? DEFAULTS.observedRules;
}

export async function setObservedRules(
  hostname: string,
  rules: DiscoveredNetworkRule[],
): Promise<void> {
  const all = await getObservedRules();
  const updated: Record<string, DiscoveredNetworkRule[]> = { ...all, [hostname]: rules };
  await chrome.storage.local.set({ observedRules: updated });
}

// --- 통계 ---

export async function getStats(): Promise<AggregateStats> {
  const { stats } = await chrome.storage.local.get<Partial<StorageSchema>>("stats");
  return stats ?? DEFAULTS.stats;
}

export async function getDomainStats(hostname: string): Promise<DomainStats> {
  const stats = await getStats();
  return stats.perDomain[hostname] ?? { networkBlocked: 0, cosmeticRemoved: 0 };
}

export async function incrementStats(
  hostname: string,
  delta: Partial<DomainStats>,
): Promise<AggregateStats> {
  const stats = await getStats();
  const current = stats.perDomain[hostname] ?? { networkBlocked: 0, cosmeticRemoved: 0 };
  const nextDomain: DomainStats = {
    networkBlocked: current.networkBlocked + (delta.networkBlocked ?? 0),
    cosmeticRemoved: current.cosmeticRemoved + (delta.cosmeticRemoved ?? 0),
  };
  const next: AggregateStats = {
    totalNetworkBlocked: stats.totalNetworkBlocked + (delta.networkBlocked ?? 0),
    totalCosmeticRemoved: stats.totalCosmeticRemoved + (delta.cosmeticRemoved ?? 0),
    perDomain: { ...stats.perDomain, [hostname]: nextDomain },
  };
  await chrome.storage.local.set({ stats: next });
  return next;
}

export async function resetStats(): Promise<void> {
  await chrome.storage.local.set({ stats: DEFAULTS.stats });
}

/** DomainRuleEntry 삭제 시 함께 호출해 통계 표에서도 해당 도메인을 지운다. */
export async function clearDomainStatsForHostnames(
  hostnames: readonly string[],
): Promise<AggregateStats> {
  const stats = await getStats();
  const perDomain = { ...stats.perDomain };
  let totalNetworkBlocked = stats.totalNetworkBlocked;
  let totalCosmeticRemoved = stats.totalCosmeticRemoved;
  let changed = false;
  for (const hostname of hostnames) {
    const domainStats = perDomain[hostname];
    if (!domainStats) continue;
    totalNetworkBlocked -= domainStats.networkBlocked;
    totalCosmeticRemoved -= domainStats.cosmeticRemoved;
    delete perDomain[hostname];
    changed = true;
  }
  if (!changed) return stats;
  const next: AggregateStats = { totalNetworkBlocked, totalCosmeticRemoved, perDomain };
  await chrome.storage.local.set({ stats: next });
  return next;
}
