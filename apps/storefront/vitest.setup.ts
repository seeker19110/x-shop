import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Không import "@testing-library/jest-dom/vitest": d.ts của nó xung đột kiểu với vitest 5 (src/types/jest-dom-vitest.d.ts).
expect.extend(matchers);

afterEach(() => cleanup());
