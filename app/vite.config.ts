import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: { port: 1420, strictPort: true, fs: { allow: [".", "../CHANGELOG.md"] }, watch: { ignored: ["**/src-tauri/**"] } },
  // mirrors the shell CSP so `bun run preview` surfaces violations before Tauri does
  preview: { port: 1421, headers: { "Content-Security-Policy": "default-src 'self'" } },
  worker: { format: "es" },
  build: {
    target: "chrome120",
    outDir: "dist",
    // CSP default-src 'self': never inline assets as data: URIs
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 700,
  },
});
