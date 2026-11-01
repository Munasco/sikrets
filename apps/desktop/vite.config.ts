import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Tauri loads the dev server in development and dist/ in a build.
export default defineConfig({
  plugins: [react(), tailwind()],
  clearScreen: false,
  server: { port: 1430, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "safari15" },
});
