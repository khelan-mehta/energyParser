import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2021",
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
