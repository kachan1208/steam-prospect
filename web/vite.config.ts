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
          //
          // `clsx` is listed EXPLICITLY with vendor-react, and that placement is
          // load-bearing (2026-08-28): clsx is also a dependency of recharts, so without
          // this rollup hoists it into vendor-recharts — and since every eager module
          // (App, Radar, RadarBoard) imports clsx directly, the entry then statically
          // depends on the 406KB recharts chunk and index.html modulepreloads it. That
          // silently defeats the route-level code splitting: /radar draws hand-rolled
          // SVG and imports no chart at all. Keep clsx out of the recharts chunk.
          manualChunks: {
            "vendor-react": ["react", "react-dom", "react-router-dom", "clsx"],
            "vendor-recharts": ["recharts"],
            "vendor-query": ["@tanstack/react-query", "@tanstack/react-table"],
          },
        },
      },
    },
  };
});
