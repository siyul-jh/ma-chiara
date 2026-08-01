import { defineManifest } from "@crxjs/vite-plugin";
import packageJson from "../package.json";
import filterMetadata from "./rules/filter-metadata.json";

const { version } = packageJson;

export default defineManifest({
  manifest_version: 3,
  name: "마! 치아라 — 광고 제거기",
  description:
    "네트워크·DOM 레벨에서 광고와 트래커를 차단하고, 스크롤 잠금 오버레이를 해제하며, 원하는 요소를 직접 골라 제거할 수 있습니다.",
  version,
  icons: {
    16: "icons/icon16.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
    default_icon: {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
  },
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  // "commands"는 permission이 아니라 아래의 최상위 매니페스트 키다 — permissions에
  // 넣으면 Chrome이 알 수 없는 권한으로 보고 로드 시 경고를 띄운다.
  // "alarms"는 코스메틱 필터를 하루 한 번 갱신하는 주기 실행에 쓴다.
  // "scripting"은 요소 선택기 토글 메시지가 실패했을 때(확장 프로그램을
  // 리로드한 뒤 새로고침하지 않은 탭 등, 콘텐츠 스크립트가 없는 경우) activeTab
  // 권한으로 즉시 재주입하기 위해 필요하다.
  permissions: ["declarativeNetRequest", "storage", "activeTab", "alarms", "scripting"],
  host_permissions: ["<all_urls>"],
  declarative_net_request: {
    // 보장 최소치(30,000) 안에 들어가는 룰셋만 켠 채로 배포한다. 나머지는
    // 전역 풀에서 가져와야 하는데 가용량이 다른 확장 프로그램에 따라 달라지므로,
    // 켠 채로 설치하면 풀이 차 있을 때 Chrome이 로드를 거부해 차단이 통째로
    // 죽는다. 서비스 워커가 실제 가용량을 확인한 뒤 추가로 켠다.
    rule_resources: Array.from({ length: filterMetadata.rulesetFileCount }, (_, i) => ({
      id: `ruleset-${i + 1}`,
      enabled: i < filterMetadata.coreRulesetCount,
      path: `src/rules/dnr-ruleset-${i + 1}.json`,
    })),
  },
  commands: {
    "toggle-element-picker": {
      suggested_key: {
        default: "Alt+Shift+X",
      },
      description: "Toggle the element picker",
    },
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: [
        "src/content/ad-block-content-script.ts",
        "src/content/scroll-unlock-content-script.ts",
        "src/content/element-picker-content-script.ts",
      ],
      run_at: "document_start",
      all_frames: true,
    },
  ],
});
