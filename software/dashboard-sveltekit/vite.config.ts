import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Vite otherwise looks beside this package and misses the monorepo's single
  // private env file. Keep the short, non-VITE names server-only; env.ts maps
  // the dashboard aliases without ever creating a public VITE_* credential.
  envDir: "../..",
  plugins: [sveltekit()],
});
