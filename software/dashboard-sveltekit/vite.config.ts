import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `globals.css` is carried over verbatim from the React dashboard and starts
// with `@import "tailwindcss";`. No Tailwind utility class is used anywhere,
// but keeping the plugin means the emitted preflight is byte-for-byte what the
// deployed dashboard already ships.
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
