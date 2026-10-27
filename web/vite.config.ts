import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Run as `vite web` from the repo root, so this config's directory (web/) is the root.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy API calls to the Express server during development.
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
