import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function injectKitRuntime(): Plugin {
  return {
    name: "inject-taste-kit-runtime",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        let out = html.replace(
          "</head>",
          '  <script src="assets/backgrounds/backgrounds.js"></script>\n</head>'
        );
        out = out.replace(
          "</body>",
          [
            '  <script type="module" src="assets/system.js"></script>',
            '  <script type="module" src="assets/motion/motion.js"></script>',
            '  <script type="module" src="assets/layout/layout.js"></script>',
            '  <script type="module" src="assets/diagrams/mount.js"></script>',
            "</body>",
          ].join("\n")
        );
        return out;
      },
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), injectKitRuntime()],
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/v1": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
