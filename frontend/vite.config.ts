import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      // Preserve the browser's Host and Origin for the backend's same-origin check.
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: false, ws: true },
    },
  },
});
