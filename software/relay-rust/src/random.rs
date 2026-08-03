//! Cryptographic randomness from the Workers runtime.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
    fn get_random_values(array: &Uint8Array);

    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    fn random_uuid_js() -> String;
}

/// `crypto.getRandomValues(new Uint8Array(n))`
pub fn random_bytes(n: usize) -> Vec<u8> {
    let array = Uint8Array::new_with_length(n as u32);
    get_random_values(&array);
    array.to_vec()
}

/// `crypto.randomUUID()` — lowercase hyphenated v4, matching the job and
/// device-event id format.
pub fn random_uuid() -> String {
    random_uuid_js()
}
