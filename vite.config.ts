import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // `npm run preview` (wrangler) owns /api; `npm run dev` proxies to it so the UI and the
    // worker share one origin without CORS. Override API_ORIGIN when the Worker runs elsewhere
    // (e.g. portless assigns a random port): API_ORIGIN=https://jornal-api.localhost npm run dev
    proxy: {
      "/api": process.env.API_ORIGIN ?? "http://127.0.0.1:8787",
    },
  },
});
