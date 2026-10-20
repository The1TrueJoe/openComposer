import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads `dist/` from disk in production and this dev server in development
// (see app/tauri.conf.json), so assets must resolve relative to index.html and the
// port must be the one Tauri expects.
export default defineConfig({
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
