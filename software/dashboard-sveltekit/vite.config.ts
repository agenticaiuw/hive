import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `globals.css` starts with `@import "tailwindcss";`. No Tailwind utility class
// is used anywhere, but keeping the plugin preserves the existing preflight.
export default defineConfig({
  // Vite otherwise looks beside this package and misses the monorepo's single
  // private env file. Keep the short, non-VITE names server-only; env.ts maps
  // the dashboard aliases without ever creating a public VITE_* credential.
  envDir: "../..",
  plugins: [tailwindcss(), sveltekit()],
});
