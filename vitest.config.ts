import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Files run in isolated environments by default (forks pool); each file
    // must stay hermetic — no top-level mutation of shared state.
  },
});
