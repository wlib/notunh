// What the Worker imports besides code, as wrangler bundles it: WebAssembly compiled, and fonts as their bytes
// (rules in wrangler.jsonc). Tests load them the same way (tests/worker/hooks.mts, vite.config.mts)

declare module "*.wasm" {
  const module: WebAssembly.Module
  export default module
}

declare module "*.woff" {
  const data: ArrayBuffer
  export default data
}
