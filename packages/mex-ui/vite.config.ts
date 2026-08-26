import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Port the `mex ui` server listens on, mirrored from src/ui/defaults.ts. */
const MEX_UI_PORT = 3847;

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The whole app is a handful of views behind a local server; one bundle
    // loads faster than a waterfall of chunks and keeps `dist/ui` tidy.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5847,
    strictPort: false,
    // `npm run dev:ui` gives hot reload against a real `mex ui --no-open`
    // backend, so the frontend is never developed against mocked data.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${MEX_UI_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
