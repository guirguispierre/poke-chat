import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Port must match the URL referenced in README Quick Start step 4
    port: 5173,
  },
});
