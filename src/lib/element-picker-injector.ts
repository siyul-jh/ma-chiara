// 요소 선택기 토글 메시지를 탭에 전달한다. 확장 프로그램을 리로드한 뒤
// 새로고침하지 않은 탭처럼 콘텐츠 스크립트가 아직 없는 경우, activeTab
// 권한으로 콘텐츠 스크립트를 즉시 주입하고 다시 시도한다 — 그래도 실패하면
// (chrome:// 등 애초에 주입 불가능한 페이지) 에러를 그대로 던진다.

function findElementPickerScriptFile(): string | undefined {
  return chrome.runtime
    .getManifest()
    .content_scripts?.flatMap((entry) => entry.js ?? [])
    .find((file) => file.includes("element-picker-content-script"));
}

export async function sendToggleElementPicker(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "toggle-element-picker" });
    return;
  } catch {
    // 아래에서 주입 후 재시도.
  }

  const scriptFile = findElementPickerScriptFile();
  if (!scriptFile) throw new Error("element-picker-content-script를 찾을 수 없음");

  await chrome.scripting.executeScript({ target: { tabId }, files: [scriptFile] });

  // 모듈 로더(crxjs)의 비동기 import가 완료되어 onMessage 리스너가 등록될 때까지 재시도
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      await chrome.tabs.sendMessage(tabId, { type: "toggle-element-picker" });
      return;
    } catch {
      // 리스너 준비 대기
    }
  }
}
