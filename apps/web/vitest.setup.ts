import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// `@testing-library/react`'s own auto-cleanup only registers when a global
// `afterEach` exists (checked via `typeof afterEach === 'function'`) —
// `vitest.config.ts` doesn't set `test.globals: true`, so that never fires
// on its own here. Without this, every `render()` in a multi-`it()` test
// file accumulates in the DOM instead of unmounting between tests, which
// silently turns a later `getByTestId` into a false "multiple elements
// found" failure the moment two tests render anything sharing a testid.
afterEach(cleanup);
