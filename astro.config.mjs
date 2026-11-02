import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  trailingSlash: "never",
  base: process.env.BASE_PATH || undefined
});
