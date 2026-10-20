import { defineConfig, mergeConfig } from "vite";
import appConfig from "../vite.config.ts";

export default mergeConfig(
  appConfig,
  defineConfig({
    server: { proxy: { "/api": { target: "http://127.0.0.1:8766" } } },
  }),
);
