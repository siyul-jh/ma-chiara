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
    // 서비스 워커에는 DOM이 없다. 기본값(true)이면 Vite가 동적 import()마다
    // <link rel=modulepreload>를 만드는 프리로드 헬퍼로 감싸는데, 그 헬퍼가
    // document.getElementsByTagName 등을 호출해 서비스 워커에서 그대로 죽는다
    // ("document is not defined"). 팝업·설정 페이지는 번들이 작아 모듈
    // 프리로드로 얻는 이득도 미미하므로 전체적으로 꺼서 이 클래스의 버그를
    // 통째로 없앤다.
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: "src/popup/index.html",
        options: "src/options/index.html",
      },
    },
  },
});
