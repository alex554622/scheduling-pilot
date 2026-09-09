// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, componentTagger (dev-only),
//     VITE_* env injection, @ path alias, React/TanStack dedupe, error logger plugins,
//     and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },

  // Production target: a plain Node server in a Docker container on Coolify.
  //
  // The preset only runs the Nitro deploy plugin when `nitro` is set explicitly
  // (or when it detects a Lovable sandbox), and its own default there is
  // `cloudflare-module`. Naming the preset does both jobs: it turns Nitro on, and
  // it pins the target to Node instead of Workers. Output lands in .output/.
  nitro: { preset: "node-server" },

  // Honour a PORT assigned by the local dev harness; otherwise fall back to the
  // shared default of 8080. Dev server only — the production port comes from
  // PORT at runtime, handled by the Nitro node-server output.
  vite: {
    server: { port: Number(process.env.PORT) || 8080 },
  },
});
