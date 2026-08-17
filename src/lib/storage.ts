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

/**
 * 런타임에 내려받은 코스메틱 필터. 네트워크 규칙은 정적 룰셋이라 확장 프로그램
 * 업데이트로만 갱신되지만, 코스메틱 선택자는 CSS일 뿐이라 DNR 상한과 무관하게
 * 런타임에 갱신할 수 있다.
 */
export interface FilterUpdateState {
  /** 내용이 실제로 바뀐 마지막 시각. */
  updatedAt: number;
  /** 상류를 확인한 마지막 시각. 변경이 없어도 갱신된다. */
  checkedAt: number;
  etag?: string;
  lastModified?: string;
  /** 번들된 범용 선택자에 없던 새 선택자. */
  addedGenericSelectors: string[];
  /** 도메인 → 선택자. 번들 맵과 병합해서 쓴다. */
  domainSelectors: Record<string, string[]>;
}

export interface StorageSchema {
  enabled: boolean;
  domainRules: Record<string, DomainRuleEntry>;
  customRemovedElements: Record<string, CustomRemovedElement[]>;
  observedRules: Record<string, DiscoveredNetworkRule[]>;
  stats: AggregateStats;
  filterUpdate: FilterUpdateState | null;
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
  filterUpdate: null,
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
    filterUpdate: stored.filterUpdate ?? DEFAULTS.filterUpdate,
  };
}

// --- 런타임 필터 갱신 ---

export async function getFilterUpdate(): Promise<FilterUpdateState | null> {
  const { filterUpdate } = await chrome.storage.local.get<Partial<StorageSchema>>("filterUpdate");
  return filterUpdate ?? DEFAULTS.filterUpdate;
}

export async function setFilterUpdate(state: FilterUpdateState): Promise<void> {
  await chrome.storage.local.set({ filterUpdate: state });
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

/**
 * 여러 호스트명에 걸쳐 수동 제거 선택자를 모아 중복을 제거해 돌려준다.
 * 미러 도메인이 같은 와일드카드 패턴의 knownHostnames로 묶여 있으면, 한
 * 미러에서 등록한 항목이 다른 미러에도 적용되게 하기 위함이다.
 */
export async function getCustomRemovedElementsForHostnames(
  hostnames: readonly string[],
): Promise<CustomRemovedElement[]> {
  const all = await getAllCustomRemovedElements();
  const seenSelectors = new Set<string>();
  const merged: CustomRemovedElement[] = [];
  for (const hostname of hostnames) {
    for (const element of all[hostname] ?? []) {
      if (seenSelectors.has(element.selector)) continue;
      seenSelectors.add(element.selector);
      merged.push(element);
    }
  }
  return merged;
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

/**
 * perDomain은 방문한 도메인마다 늘어나기만 하므로 상한을 둔다. 넘치면 집계가
 * 가장 적은 도메인부터 버린다 — 합계(total*)는 건드리지 않으므로 누적 총량은
 * 유지된다.
 */
const MAX_TRACKED_DOMAINS = 500;

function prunePerDomain(
  perDomain: Record<string, DomainStats>,
  keepHostname: string,
): Record<string, DomainStats> {
  const entries = Object.entries(perDomain);
  if (entries.length <= MAX_TRACKED_DOMAINS) return perDomain;
  const ranked = entries
    .filter(([hostname]) => hostname !== keepHostname)
    .sort(([, a], [, b]) => b.cosmeticRemoved - a.cosmeticRemoved)
    .slice(0, MAX_TRACKED_DOMAINS - 1);
  const kept = Object.fromEntries(ranked);
  const current = perDomain[keepHostname];
  if (current) kept[keepHostname] = current;
  return kept;
}

/**
 * 읽기-수정-쓰기라 동시에 부르면 갱신이 유실된다. 서비스 워커 한 곳에서만
 * 직렬화해 호출할 것 — 콘텐츠 스크립트가 직접 부르면 탭마다 경쟁한다.
 */
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
    perDomain: prunePerDomain({ ...stats.perDomain, [hostname]: nextDomain }, hostname),
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
