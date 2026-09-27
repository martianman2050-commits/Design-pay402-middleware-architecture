// Regression fixture for the tsx/ESM re-export bug: importing the package
// surface through a single-file transpiler must not throw
// "does not provide an export named 'CoreDecision'" (type re-exported as a
// named value export). Executed by test/package-surface.test.ts via tsx.

import "../../src/index.js";

console.log("SURFACE_OK");
