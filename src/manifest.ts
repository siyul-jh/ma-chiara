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
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  permissions: ["declarativeNetRequest", "storage", "activeTab", "scripting", "commands"],
  host_permissions: ["<all_urls>"],
  declarative_net_request: {
    rule_resources: Array.from({ length: filterMetadata.rulesetFileCount }, (_, i) => ({
      id: `ruleset-${i + 1}`,
      enabled: true,
      path: `src/rules/dnr-ruleset-${i + 1}.json`,
    })),
  },
  commands: {
    "toggle-element-picker": {
      suggested_key: {
        default: "Alt+Shift+P",
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
