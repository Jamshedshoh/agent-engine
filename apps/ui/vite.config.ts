import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI talks to the engine same-origin through this proxy, so the engine needs no CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/services": process.env.API_URL ?? "http://localhost:3000" },
  },
});
