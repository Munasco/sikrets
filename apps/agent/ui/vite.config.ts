import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Built to static files the gateway serves (SERVER.uiDir). In dev, API calls go to a local gateway.
export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": { target: process.env.GATEWAY ?? "http://127.0.0.1:8787", changeOrigin: true }, "/attestation": process.env.GATEWAY ?? "http://127.0.0.1:8787" } },
});
