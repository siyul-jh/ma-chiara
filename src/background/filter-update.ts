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
import { fetchBundledJson } from "../lib/fetch-bundled-json";
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

export interface FilterUpdateResult {
  outcome: FilterUpdateOutcome;
  /** outcome이 "failed"일 때만 채워지는, 설정 페이지에 그대로 보여줄 실패 사유. */
  reason?: string;
}

let bundledGenericPromise: Promise<Set<string>> | undefined;

function loadBundledGenericSelectors(): Promise<Set<string>> {
  if (!bundledGenericPromise) {
    bundledGenericPromise = fetchBundledJson<string[]>("rules/cosmetic-selectors.json").then(
      (selectors) => new Set(selectors),
    );
  }
  return bundledGenericPromise;
}

interface FetchOutcome {
  response: Response | null;
  reason?: string;
}

async function fetchFilterList(headers: Record<string, string>): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(EASYLIST_URL, { headers, signal: controller.signal, redirect: "follow" });
    return { response };
  } catch (error) {
    // 타임아웃이면 AbortError, 그 외 네트워크 오류는 TypeError.
    const isTimeout = error instanceof DOMException && error.name === "AbortError";
    console.error("[마! 치아라] 필터 목록을 내려받지 못했습니다.", error);
    return {
      response: null,
      reason: isTimeout
        ? "필터 서버 응답이 너무 느립니다(시간 초과). 잠시 후 다시 시도해 주세요."
        : "필터 서버에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.",
    };
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
export async function runFilterUpdate(options: { force?: boolean } = {}): Promise<FilterUpdateResult> {
  const current = await getFilterUpdate();

  const headers: Record<string, string> = {};
  if (!options.force && current) {
    // 변경이 없으면 2MB를 다시 받지 않는다.
    if (current.etag) headers["If-None-Match"] = current.etag;
    if (current.lastModified) headers["If-Modified-Since"] = current.lastModified;
  }

  const { response, reason: fetchFailureReason } = await fetchFilterList(headers);
  if (!response) return { outcome: "failed", reason: fetchFailureReason };

  if (response.status === 304) {
    if (current) await setFilterUpdate({ ...current, checkedAt: Date.now() });
    return { outcome: "unchanged" };
  }

  if (!response.ok) {
    console.error(`[마! 치아라] 필터 목록 응답이 정상이 아닙니다: ${response.status}`);
    return {
      outcome: "failed",
      reason: `필터 서버가 오류를 반환했습니다 (HTTP ${response.status}). 잠시 후 다시 시도해 주세요.`,
    };
  }

  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_DOWNLOAD_BYTES) {
    console.error(`[마! 치아라] 필터 목록이 지나치게 큽니다: ${declaredSize} bytes`);
    return { outcome: "failed", reason: "필터 목록 크기가 예상보다 커서 갱신을 건너뛰었습니다." };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    console.error("[마! 치아라] 필터 목록을 읽지 못했습니다.", error);
    return { outcome: "failed", reason: "필터 목록을 내려받는 중 오류가 발생했습니다." };
  }

  if (text.length > MAX_DOWNLOAD_BYTES) {
    console.error("[마! 치아라] 필터 목록이 지나치게 큽니다.");
    return { outcome: "failed", reason: "필터 목록 크기가 예상보다 커서 갱신을 건너뛰었습니다." };
  }

  const parsed = parseCosmeticFilters(text);

  // 상류가 비었거나 형식이 깨졌다면 기존 갱신본을 지우지 않는다.
  if (parsed.genericSelectors.length === 0 && Object.keys(parsed.domainSelectors).length === 0) {
    console.error("[마! 치아라] 내려받은 필터 목록에서 유효한 규칙을 찾지 못했습니다.");
    return {
      outcome: "failed",
      reason: "내려받은 필터 목록에서 유효한 규칙을 찾지 못했습니다. 상류 형식이 바뀌었을 수 있습니다.",
    };
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

  return { outcome: "updated" };
}
