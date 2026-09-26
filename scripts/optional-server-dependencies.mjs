import path from "node:path";
import { createRequire } from "node:module";
import { OPTIONAL_BRIDGE_SDKS } from "../lib/bridge/optional-sdks.ts";

// Bundlers rename createRequire bindings, which can hide lazy SDKs from nft.
// Trace their entrypoints explicitly, including all transitive dependencies.
export function optionalServerDependencyRoots(rootDir, installedNames = OPTIONAL_BRIDGE_SDKS) {
  const require = createRequire(path.join(rootDir, "package.json"));
  return OPTIONAL_BRIDGE_SDKS
    .filter((name) => installedNames.includes(name))
    .map((name) => require.resolve(name));
}
