// Plain Vite config. This previously came from a vendor preset that assembled
// the plugin list for us; the equivalent setup is spelled out here instead so
// the build has no vendor-specific wrapper in it.
//
// Order matters: tailwind and the tsconfig path resolver run before
// tanstackStart, and the React plugin goes last.
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  // Vite only exposes VITE_* on import.meta.env inside transformed client code.
  // SSR modules and server functions read the same values through process.env,
  // so inline them explicitly to keep both halves seeing one source of truth.
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), "VITE_"))) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  // `vite build --mode development` (the build:dev script) keeps React in its
  // development build for DevTools. Scoped to the client environment: flipping
  // NODE_ENV globally emits jsxDEV, which the react-server SSR runtime cannot
  // resolve.
  const isDevBuild = command === "build" && mode === "development";

  return {
    define,
    ...(isDevBuild
      ? {
          environments: {
            client: { define: { "process.env.NODE_ENV": JSON.stringify("development") } },
          },
          esbuild: { keepNames: true },
        }
      : {}),

    // Vite uses PostCSS in dev but Lightning CSS at build, so a build-time
    // transform can break the built output while the dev preview still looks
    // fine. Running Lightning CSS in both keeps the preview honest.
    css: { transformer: "lightningcss" },

    resolve: {
      alias: { "@": `${process.cwd()}/src` },
      // A second copy of React or the query client breaks hooks and cache
      // identity across the SSR/client boundary.
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
        "@tanstack/query-core",
      ],
    },

    // Dep re-optimization rotates the optimized-dep hash and 504s tabs holding
    // the old one. Pre-bundle the always-present client deps and tolerate stale
    // requests. React core only: pulling in @tanstack/react-start would drag its
    // node:async_hooks server entry into the client bundle and crash hydration.
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
      ignoreOutdatedRequests: true,
    },

    server: {
      host: "::",
      // Honour a PORT assigned by the local dev harness; otherwise fall back to
      // 8080. Dev server only — the production port comes from PORT at runtime,
      // handled by the Nitro node-server output.
      port: Number(process.env.PORT) || 8080,
      // Without this, a save mid-write can be picked up as a truncated file.
      watch: { awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 } },
    },

    plugins: [
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        // Redirect the bundled server entry to src/server.ts (our SSR error wrapper).
        server: { entry: "server" },
        // Importing server-only modules from client code should fail the build,
        // not ship a broken bundle.
        importProtection: {
          behavior: "error",
          client: { files: ["**/server/**"], specifiers: ["server-only"] },
        },
      }),
      // Production target: a plain Node server in a Docker container on Coolify.
      // Output lands in .output/. Build-only; the plugin is a no-op on serve.
      ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
      viteReact(),
    ],
  };
});
