import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts (which is dev/build-server only) so `npm run test` doesn't
// need to reason about the /api proxy or build.rollupOptions. Explicit `describe`/`it`/
// `expect` imports in test files (no `globals: true`) — keeps type resolution simple and
// avoids adding a `vitest/globals` types entry to tsconfig.json.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
