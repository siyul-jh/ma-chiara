// 코스메틱 필터의 런타임 갱신.
//
// 네트워크 규칙(정적 DNR 룰셋)은 확장 프로그램 패키지의 일부라 여기서 바꿀 수
// 없다 — 그쪽은 재빌드·재배포가 유일한 경로다. 반면 코스메틱 선택자는 결국
// CSS일 뿐이라 DNR 상한과 무관하게 런타임에 받아 적용할 수 있고, 사이트 개편
// 때문에 가장 빨리 낡는 것도 이쪽이다.
//
// MV3는 원격 *실행 코드*를 금지할 뿐 원격 *데이터*는 허용한다. 내려받는 것은
// 필터 목록 텍스트뿐이고, 해석은 번들된 파서가 로컬에서만 수행한다.

import { parseCosmeticFilters } from "../lib/cosmetic-filter-parser";
import { getFilterUpdate, setFilterUpdate } from "../lib/storage";

const EASYLIST_URL = "https://easylist.to/easylist/easylist.txt";

// EasyList는 약 2MB다. 상류가 이상해졌을 때 메모리를 통째로 먹지 않도록 넉넉한
// 상한만 둔다.
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

// 새로 늘어난 범용 선택자는 모든 페이지 응답에 실려 나가므로 상한을 둔다.
// 주기적으로 재빌드하는 한 실제 증가분은 수십 개 수준이다.
const MAX_ADDED_GENERIC_SELECTORS = 2_000;

export type FilterUpdateOutcome = "updated" | "unchanged" | "failed";

let bundledGenericPromise: Promise<Set<string>> | undefined;

function loadBundledGenericSelectors(): Promise<Set<string>> {
  if (!bundledGenericPromise) {
    bundledGenericPromise = import("../rules/cosmetic-selectors.json").then(
      (mod) => new Set(mod.default as string[]),
    );
  }
  return bundledGenericPromise;
}

async function fetchFilterList(headers: Record<string, string>): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(EASYLIST_URL, { headers, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    console.error("[마! 치아라] 필터 목록을 내려받지 못했습니다.", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 상류 필터 목록을 확인해 코스메틱 선택자를 갱신한다.
 *
 * 어떤 단계에서 실패하든 기존 상태를 그대로 두고 "failed"를 돌려준다 —
 * 번들된 필터는 항상 살아 있으므로, 갱신 실패가 차단 기능을 망가뜨려서는
 * 안 된다(fail-closed).
 */
export async function runFilterUpdate(options: { force?: boolean } = {}): Promise<FilterUpdateOutcome> {
  const current = await getFilterUpdate();

  const headers: Record<string, string> = {};
  if (!options.force && current) {
    // 변경이 없으면 2MB를 다시 받지 않는다.
    if (current.etag) headers["If-None-Match"] = current.etag;
    if (current.lastModified) headers["If-Modified-Since"] = current.lastModified;
  }

  const response = await fetchFilterList(headers);
  if (!response) return "failed";

  if (response.status === 304) {
    if (current) await setFilterUpdate({ ...current, checkedAt: Date.now() });
    return "unchanged";
  }

  if (!response.ok) {
    console.error(`[마! 치아라] 필터 목록 응답이 정상이 아닙니다: ${response.status}`);
    return "failed";
  }

  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_DOWNLOAD_BYTES) {
    console.error(`[마! 치아라] 필터 목록이 지나치게 큽니다: ${declaredSize} bytes`);
    return "failed";
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    console.error("[마! 치아라] 필터 목록을 읽지 못했습니다.", error);
    return "failed";
  }

  if (text.length > MAX_DOWNLOAD_BYTES) {
    console.error("[마! 치아라] 필터 목록이 지나치게 큽니다.");
    return "failed";
  }

  const parsed = parseCosmeticFilters(text);

  // 상류가 비었거나 형식이 깨졌다면 기존 갱신본을 지우지 않는다.
  if (parsed.genericSelectors.length === 0 && Object.keys(parsed.domainSelectors).length === 0) {
    console.error("[마! 치아라] 내려받은 필터 목록에서 유효한 규칙을 찾지 못했습니다.");
    return "failed";
  }

  const bundled = await loadBundledGenericSelectors();
  const addedGenericSelectors = parsed.genericSelectors
    .filter((selector) => !bundled.has(selector))
    .slice(0, MAX_ADDED_GENERIC_SELECTORS);

  const now = Date.now();
  await setFilterUpdate({
    updatedAt: now,
    checkedAt: now,
    etag: response.headers.get("etag") ?? undefined,
    lastModified: response.headers.get("last-modified") ?? undefined,
    addedGenericSelectors,
    domainSelectors: parsed.domainSelectors,
  });

  return "updated";
}
