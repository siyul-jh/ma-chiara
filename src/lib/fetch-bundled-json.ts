// 서비스 워커에서 번들된 정적 JSON을 읽는다. 동적 import()는
// ServiceWorkerGlobalScope에서 스펙상 금지되어 있으므로
// (https://github.com/w3c/ServiceWorker/issues/1356) chrome.runtime.getURL()
// + fetch()로 대신한다. 대상 파일은 해시 없이 원본 그대로 정적 서빙되는
// public/ 아래 있어야 한다 — scripts/build-filter-rules.ts 참고.
export async function fetchBundledJson<T>(publicRelativePath: string): Promise<T> {
  const response = await fetch(chrome.runtime.getURL(publicRelativePath));
  return (await response.json()) as T;
}
