// What a page's code has in place of temporal-polyfill until it asks for it (temporal.mts, "#temporal" in
// package.json): nothing, so an engine with its own Temporal never downloads the polyfill

export const Temporal = undefined
