/*
 * Workers path: wrangler's built-in CompiledWasm rule turns this static
 * import into a deploy-time WebAssembly.Module (the only wasm Workers
 * allow). Node (tests) cannot import .wasm — opusTranscode catches the
 * failure of importing THIS file and compiles from bytes instead.
 */
import wasmModule from './libopus.wasm'

export default wasmModule
