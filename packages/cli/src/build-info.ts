/**
 * The identity of this build: the release version and the commit it was cut
 * from. A leaf module (no imports) so every command, and the JSON conventions
 * in json-output.ts, can name the build without importing the proxy.
 *
 * scripts/build-cli-package.ts stamps both values into the bundled runtime; a
 * run from source falls back to the environment, then to placeholders.
 */
declare const __MESH_BUILD_COMMIT__: string | undefined;
declare const __MESH_VERSION__: string | undefined;

export const BUILD_COMMIT =
  typeof __MESH_BUILD_COMMIT__ !== "undefined" ? __MESH_BUILD_COMMIT__ : (process.env.MESH_BUILD_COMMIT ?? "dev");

export const VERSION =
  typeof __MESH_VERSION__ !== "undefined" ? __MESH_VERSION__ : (process.env.MESH_VERSION ?? "0.0.0");
