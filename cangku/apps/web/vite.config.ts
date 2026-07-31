import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "云裳仓库",
        short_name: "云裳仓库",
        description: "服装仓库协作管理系统",
        theme_color: "#f4f5f2",
        background_color: "#f4f5f2",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
          { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        runtimeCaching: [],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"]
      }
    })
  ],
  server: {
    port: 5173,
    strictPort: false,
    proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: true } }
  },
  test: {
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"]
  }
});
