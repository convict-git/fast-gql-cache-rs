use wasm_bindgen::prelude::*;

/// Called from TypeScript to verify Rust-WASM interop.
///
/// Returns a marker instead of logging it: a cache must not write to the
/// console, and the behaviour-parity probe compares console output byte for
/// byte against Apollo's `InMemoryCache`.
#[wasm_bindgen]
pub fn convict_in_the_game() -> String {
    String::from("convict in the game")
}
