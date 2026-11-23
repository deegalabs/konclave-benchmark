// SPDX-License-Identifier: MIT OR Apache-2.0
//! The scan stages of the page (decode, trial decryption, tree, witnesses) run natively on a saved corpus, timed apart:
//! a native floor beside the browser rows. Information, never a verdict. With `--features threads` the decryption and
//! the `subtrees` tree mode use rayon on every core (RAYON_NUM_THREADS sets the count); without it, one thread.
//! usage: cargo run --release --example native_scan [--features threads] -- <corpus.bin> <ufvk file> <chunked|subtrees|per-block> [runs]
use konclave_benchmark::{scan::Scan, tree::TreeInsert};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 4 {
        eprintln!("usage: native_scan <corpus.bin> <ufvk file> <chunked|subtrees|per-block> [runs]");
        std::process::exit(2);
    }
    let file = std::fs::read(&a[1]).expect("corpus");
    let ufvk = std::fs::read_to_string(&a[2]).expect("ufvk file");
    let mode = TreeInsert::from_name(&a[3]).expect("mode");
    let runs: usize = a.get(4).and_then(|r| r.parse().ok()).unwrap_or(5);
    let threads = if cfg!(feature = "threads") {
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    } else {
        1
    };
    for run in 0..runs {
        let mut s = Scan::from_corpus(&file).expect("corpus");
        s.set_ufvk_inner(ufvk.trim()).expect("ufvk");
        s.set_tree_insert_mode(mode).expect("mode");
        let t = Instant::now();
        s.decode_inner().expect("decode");
        let decode = t.elapsed().as_secs_f64();
        let t = Instant::now();
        s.decrypt_inner().expect("decrypt");
        let decrypt = t.elapsed().as_secs_f64();
        let t = Instant::now();
        s.tree_inner().expect("tree");
        let tree = t.elapsed().as_secs_f64();
        let t = Instant::now();
        s.witness_inner().expect("witness");
        let witness = t.elapsed().as_secs_f64();
        let (pieces, batches) = s.tree_insert_counts();
        println!(
            "{{\"run\":{},\"mode\":\"{}\",\"threads\":{},\"decode_s\":{:.3},\"decrypt_s\":{:.3},\"tree_s\":{:.3},\"total_s\":{:.3},\"witness_s\":{:.3},\"subtrees\":{},\"batch_inserts\":{}}}",
            run + 1,
            mode.label(),
            threads,
            decode,
            decrypt,
            tree,
            decode + decrypt + tree,
            witness,
            pieces,
            batches
        );
    }
}
