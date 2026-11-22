// SPDX-License-Identifier: MIT OR Apache-2.0
//! The `subtrees` insertion mode (one located subtree per shard, built apart and then inserted, as zcash_client_backend
//! 0.25 `build_subtrees` does, data_api/ll/wallet.rs) against the chunked and per-block modes: the same roots at every
//! checkpoint, the same witnesses, wherever the range starts, and the subtrees really are built and inserted per shard.
use incrementalmerkletree::{frontier::Frontier, Position};
use konclave_benchmark::{
    scan::Scan,
    synth::{self, Params},
    tree::{PoolTree, TreeInsert},
};
use orchard::tree::MerkleHashOrchard;
use rand::{rngs::StdRng, Rng, SeedableRng};

const SHARD: u64 = 1 << 16;

fn leaf(rng: &mut StdRng) -> MerkleHashOrchard {
    let mut b = [0u8; 32];
    rng.fill_bytes(&mut b[..31]);
    MerkleHashOrchard::from_bytes(&b).unwrap()
}

fn start_at(pos: u64, rng: &mut StdRng) -> Frontier<MerkleHashOrchard, 32> {
    let position = Position::from(pos);
    let ommers = (0..position.past_ommer_count())
        .map(|_| leaf(rng))
        .collect();
    Frontier::from_parts(position, leaf(rng), ommers).unwrap()
}

/// Blocks of 0 to 3 leaves, some blocks empty, every fifth leaf ours.
fn range(blocks: usize, rng: &mut StdRng) -> (Vec<usize>, Vec<MerkleHashOrchard>, Vec<bool>) {
    let sizes: Vec<usize> = (0..blocks)
        .map(|b| if b % 5 == 4 { 0 } else { 1 + b % 3 })
        .collect();
    let n: usize = sizes.iter().sum();
    let cmxs = (0..n).map(|_| leaf(rng)).collect();
    let ours = (0..n).map(|i| i % 5 == 0).collect();
    (sizes, cmxs, ours)
}

fn build(
    start: &Frontier<MerkleHashOrchard, 32>,
    sizes: &[usize],
    cmxs: &[MerkleHashOrchard],
    ours: &[bool],
    chunk: usize,
    subtrees: bool,
) -> PoolTree {
    let mut t = PoolTree::with_max_checkpoints(start.clone(), 100_000).unwrap();
    t.set_subtrees(subtrees);
    let mut at = 0;
    for blocks in sizes.chunks(chunk) {
        let total: usize = blocks.iter().sum();
        let mut ends = Vec::new();
        let mut e = 0;
        for s in blocks {
            e += s;
            ends.push(e);
        }
        t.append_chunk(&cmxs[at..at + total], &ours[at..at + total], &ends)
            .unwrap();
        at += total;
    }
    t
}

fn same(a: &PoolTree, b: &PoolTree, blocks: u64) {
    assert_eq!(a.size(), b.size());
    assert_eq!(a.root().unwrap(), b.root().unwrap(), "the final root");
    for id in 0..blocks {
        assert_eq!(
            a.root_at_block(id).unwrap(),
            b.root_at_block(id).unwrap(),
            "root at block {id}"
        );
    }
    assert_eq!(a.checkpoint_ids().unwrap(), b.checkpoint_ids().unwrap());
    assert_eq!(a.marked(), b.marked());
    for (pos, h) in a.marked() {
        for id in [blocks - 1, blocks / 2] {
            assert_eq!(
                a.witness_root_at_block(*pos, *h, id).ok(),
                b.witness_root_at_block(*pos, *h, id).ok(),
                "witness of {pos:?} at block {id}"
            );
        }
    }
    assert_eq!(a.witnesses().unwrap(), b.witnesses().unwrap());
}

#[test]
fn subtrees_give_the_same_roots_checkpoints_and_witnesses_as_chunks_and_per_block() {
    let mut rng = StdRng::seed_from_u64(11);
    let (sizes, cmxs, ours) = range(60, &mut rng);
    let blocks = sizes.len() as u64;
    // An empty tree, a start in the middle of a shard, and starts just before a shard boundary (the range crosses it).
    for start in [
        Frontier::empty(),
        start_at(1_000, &mut rng),
        start_at(SHARD - 3, &mut rng),
        start_at(SHARD - 1, &mut rng),
    ] {
        let per_block = build(&start, &sizes, &cmxs, &ours, 1, false);
        for chunk in [7, 60] {
            let chunked = build(&start, &sizes, &cmxs, &ours, chunk, false);
            let sub = build(&start, &sizes, &cmxs, &ours, chunk, true);
            same(&per_block, &sub, blocks);
            same(&chunked, &sub, blocks);
        }
    }
}

#[test]
fn a_range_over_several_shards_is_built_as_one_subtree_per_shard() {
    let mut rng = StdRng::seed_from_u64(12);
    // About 140,000 leaves in 200 blocks from position 30,001: shards 0 (part), 1 (whole) and 2 (part), so three
    // subtrees in one chunk. Big blocks keep the checkpoints few, so the test stays fast.
    let sizes: Vec<usize> = (0..200)
        .map(|b| if b % 9 == 8 { 0 } else { 700 + 7 * (b % 9) })
        .collect();
    let n: usize = sizes.iter().sum();
    let cmxs: Vec<MerkleHashOrchard> = (0..n).map(|_| leaf(&mut rng)).collect();
    let ours: Vec<bool> = (0..n).map(|i| i % 9_001 == 0).collect();
    let start = start_at(30_000, &mut rng);
    let blocks = sizes.len() as u64;
    let chunked = build(&start, &sizes, &cmxs, &ours, 200, false);
    let sub = build(&start, &sizes, &cmxs, &ours, 200, true);
    same(&chunked, &sub, blocks);
    let first = 30_001u64;
    let last = first + cmxs.len() as u64 - 1;
    let expected = last / SHARD - first / SHARD + 1;
    assert_eq!(
        sub.subtrees_inserted(),
        expected,
        "one subtree per shard the leaves touch"
    );
    assert_eq!(
        chunked.subtrees_inserted(),
        0,
        "the chunked mode builds no subtree"
    );
}

#[test]
fn a_scan_in_subtrees_mode_matches_per_block_and_records_the_mode() {
    let file = synth::generate(Params {
        blocks: 53,
        txs_per_block: 1,
        actions_per_tx: 3,
        ours_every: 2,
        ..Default::default()
    });
    let run = |mode: TreeInsert| {
        let mut s = Scan::from_corpus(&file).unwrap();
        s.set_tree_insert_mode(mode).unwrap();
        s.decode_inner().unwrap();
        s.decrypt_inner().unwrap();
        s.tree_inner().unwrap();
        s.witness_inner().unwrap();
        s
    };
    let per_block = run(TreeInsert::PerBlock);
    let sub = run(TreeInsert::from_name("subtrees").unwrap());
    for p in 0..2 {
        assert_eq!(sub.root_bytes(p).unwrap(), per_block.root_bytes(p).unwrap());
    }
    assert!(sub.summary().contains("\"tree_insert\":\"subtrees-10000\""));
}
