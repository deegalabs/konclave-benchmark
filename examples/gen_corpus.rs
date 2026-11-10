// SPDX-License-Identifier: MIT OR Apache-2.0
//! cargo run --release --example gen_corpus -- <out.bin> [blocks] [txs per block] [actions per tx]
use konclave_benchmark::synth::{generate_with_end, Params};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let n = |i: usize, d: u32| a.get(i).map_or(d, |s| s.parse().expect("a number"));
    let p = Params { blocks: n(2, 200), txs_per_block: n(3, 2), actions_per_tx: n(4, 16), ours_every: 10, ..Default::default() };
    let out = a.get(1).expect("usage: gen_corpus <out.bin> [blocks] [txs] [actions]");
    let (corpus, end) = generate_with_end(p);
    let d: String = corpus[8..40].iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(format!("{out}.sha256"), format!("{d}\n")).unwrap();
    std::fs::write(out, corpus).unwrap();
    // For the mock light client server: the tree states it answers for the last height.
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    std::fs::write(format!("{out}.end.json"), format!("{{\"orchard\":\"{}\",\"ironwood\":\"{}\"}}", hex(&end[0]), hex(&end[1]))).unwrap();
}
