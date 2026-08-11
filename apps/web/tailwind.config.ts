// Vestigial under Tailwind v4 (CSS-first config): content is auto-detected
// and dark mode is a `@custom-variant` in `src/app/globals.css`, not a JS
// config key. Kept only because `components.json` still points at this
// path — shadcn's CLI expects it to exist, even though nothing here is
// actually loaded by the v4 build pipeline.
import type { Config } from "tailwindcss";

const config: Config = {
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
