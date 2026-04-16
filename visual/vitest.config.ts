import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    fs: {
      allow: [".."],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
