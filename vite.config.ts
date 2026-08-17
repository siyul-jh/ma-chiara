import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest";

const OUT_DIR = "dist";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // 서비스 워커에는 DOM이 없다. 기본값(true)이면 Vite가 HTML 엔트리에
    // <link rel=modulepreload>를 주입하는데, 그 폴리필이 document를 호출해
    // 서비스 워커에서 죽는다. 팝업·설정 페이지는 번들이 작아 이득도 미미하므로
    // 꺼둔다. (서비스 워커 JS 안의 동적 import() 프리로드 헬퍼는 이 옵션과
    // 무관하게 남는데, 그건 service-worker.ts의 window 별칭으로 막는다.)
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: "src/popup/index.html",
        options: "src/options/index.html",
      },
    },
  },
});
