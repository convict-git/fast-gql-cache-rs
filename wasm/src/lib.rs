use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Called from TypeScript to verify Rust-WASM interop.
#[wasm_bindgen]
pub fn convict_in_the_game() {
    log("convict in the game");
}
