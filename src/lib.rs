// SPDX-License-Identifier: MIT OR Apache-2.0
//! Harness for what scanning and proving cost in a browser. See README.md for what it does and does not measure.
use wasm_bindgen::prelude::*;

pub mod corpus;
#[cfg(not(target_arch = "wasm32"))]
pub mod pack;
pub mod proto;
pub mod prove;
pub mod scan;
#[cfg(not(target_arch = "wasm32"))]
pub mod synth;
pub mod tree;

#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

/// The threads this build really uses: 1 in the single-thread build, whatever the page asked for.
#[wasm_bindgen]
pub fn thread_count() -> u32 {
    #[cfg(feature = "threads")]
    {
        rayon::current_num_threads() as u32
    }
    #[cfg(not(feature = "threads"))]
    {
        1
    }
}

#[wasm_bindgen]
pub fn build_flavour() -> String {
    if cfg!(feature = "threads") {
        "threads".into()
    } else {
        "single".into()
    }
}
