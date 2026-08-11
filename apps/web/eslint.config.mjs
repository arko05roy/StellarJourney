import base from "@paymap/config/eslint";

export default [
  ...base,
  {
    // The Playwright e2e fixture is plain Node (`node:http`), not compiled
    // through the shared TS config — the base config's `js.configs.recommended`
    // has no Node globals by default (only browser/ES globals), so `process`/
    // `console`/`URL` need declaring here rather than pulling in a whole
    // `globals` package dependency for three identifiers.
    files: ["e2e/fixtures/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
];
