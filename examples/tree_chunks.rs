// SPDX-License-Identifier: MIT OR Apache-2.0
//! Times the tree stage of one pool natively over random commitments, chunked against per-block, and checks that both reach
//! the same root. usage: cargo run --release --example tree_chunks -- [blocks] [actions per block x100]
//! (50000 and 1241 by default: 12.41 commitments a block, one in 5,000 marked).
use incrementalmerkletree::frontier::Frontier;
use konclave_benchmark::tree::{PoolTree, CHUNK_BLOCKS};
use orchard::tree::MerkleHashOrchard;
use rand::{rngs::StdRng, Rng, SeedableRng};
use std::time::Instant;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let blocks: usize = a.get(1).map_or(50_000, |s| s.parse().unwrap());
    let per100: usize = a.get(2).map_or(1241, |s| s.parse().unwrap());
    let mut rng = StdRng::seed_from_u64(7);
    let (mut acc, mut k) = (0usize, 0u64);
    let mut cmxs = Vec::new();
    let mut ours = Vec::new();
    let mut ends = Vec::new();
    for _ in 0..blocks {
        acc += per100;
        for _ in 0..acc / 100 {
            let mut b = [0u8; 32];
            rng.fill_bytes(&mut b[..31]);
            cmxs.push(MerkleHashOrchard::from_bytes(&b).unwrap());
            k += 1;
            ours.push(k % 5000 == 0);
        }
        acc %= 100;
        ends.push(cmxs.len());
    }
    println!("blocks {blocks} leaves {}", cmxs.len());
    let mut roots = Vec::new();
    for chunk in [1, CHUNK_BLOCKS] {
        let t = Instant::now();
        let mut tree = PoolTree::new(Frontier::empty()).unwrap();
        let (mut from, mut at) = (0usize, 0usize);
        while from < blocks {
            let to = (from + chunk).min(blocks);
            let end = ends[to - 1];
            let rel: Vec<usize> = ends[from..to].iter().map(|e| e - at).collect();
            tree.append_chunk(&cmxs[at..end], &ours[at..end], &rel)
                .unwrap();
            (from, at) = (to, end);
        }
        let root = tree.root().unwrap().to_bytes();
        let secs = t.elapsed().as_secs_f64();
        let witnesses = tree.witnesses().unwrap();
        println!("chunk_blocks {chunk}: {secs:.2} s with the root, then {witnesses} witnesses");
        roots.push(root);
    }
    println!("same root: {}", roots[0] == roots[1]);
}
