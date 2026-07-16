import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev/preview both proxy /api -> the FastAPI server so the browser fetch stays
// same-origin (no CORS dance) and src/lib/api.ts can default to a relative "/api".
// Target defaults to the :8001 dev instance; override with VITE_API_PROXY_TARGET
// (shell env or web/.env) to point at a different instance, e.g. a long-running :8000.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8001";
  const apiProxy = {
    "/api": {
      target,
      changeOrigin: true,
    },
  };

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: apiProxy,
    },
    preview: {
      port: 4173,
      proxy: apiProxy,
    },
    build: {
      rollupOptions: {
        output: {
          // Split the big, rarely-changing vendor libs into their own chunks so an
          // app-code change doesn't invalidate the (larger) charting/query caches.
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom"],
            "vendor-recharts": ["recharts"],
            "vendor-query": ["@tanstack/react-query", "@tanstack/react-table"],
          },
        },
      },
    },
  };
});
