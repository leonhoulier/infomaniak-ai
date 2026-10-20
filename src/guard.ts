import { createReadOnlyFetch } from "./policy.js";

// Preloaded inside the audited adapter process, before its HTTP client is imported.
globalThis.fetch = createReadOnlyFetch(globalThis.fetch);
