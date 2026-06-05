import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom)[\\/]/,
              priority: 3,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-|micromark|mdast-|hast-|unified|unist-|vfile)[\\/]/,
              priority: 2,
            },
            {
              name: "ui",
              test: /node_modules[\\/](radix-ui|@radix-ui|lucide-react|class-variance-authority|clsx|tailwind-merge)[\\/]/,
              priority: 1,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
            },
          ],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
});
