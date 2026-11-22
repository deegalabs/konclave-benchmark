// SPDX-License-Identifier: MIT OR Apache-2.0
//! The `subtrees` insertion mode (pieces of 1,024 leaves built apart and then inserted, as zcash_client_backend 0.25
//! `update_tree` / `build_subtrees` do, data_api/ll/wallet.rs) against the chunked and per-block modes: the same roots at
//! every checkpoint, the same witnesses, wherever the range starts, with pruning on, and the mode really builds its
//! pieces and makes no `batch_insert`.
use incrementalmerkletree::{frontier::Frontier, Position};
use konclave_benchmark::{
    scan::Scan,
    synth::{self, Params},
    tree::{PoolTree, TreeInsert, SUBTREE_LEAVES},
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
    build_keep(start, sizes, cmxs, ours, chunk, subtrees, 100_000)
}

fn build_keep(
    start: &Frontier<MerkleHashOrchard, 32>,
    sizes: &[usize],
    cmxs: &[MerkleHashOrchard],
    ours: &[bool],
    chunk: usize,
    subtrees: bool,
    keep: usize,
) -> PoolTree {
    let mut t = PoolTree::with_max_checkpoints(start.clone(), keep).unwrap();
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
fn a_chunk_is_cut_into_pieces_of_1024_leaves_counted_from_its_start_and_crosses_a_shard_boundary() {
    let mut rng = StdRng::seed_from_u64(12);
    // 5,000 leaves in 400 blocks from position SHARD - 2,000: five pieces (4 x 1,024 + 904), one of them across the shard
    // boundary, not aligned to it; pruning on (100 checkpoints, as a scan keeps).
    let sizes: Vec<usize> = (0..400)
        .map(|b| if b % 7 == 6 { 0 } else { 14 + b % 3 })
        .collect();
    let n: usize = sizes.iter().sum();
    let cmxs: Vec<MerkleHashOrchard> = (0..n).map(|_| leaf(&mut rng)).collect();
    let ours: Vec<bool> = (0..n).map(|i| i % 97 == 0).collect();
    let start = start_at(SHARD - 2_001, &mut rng);
    for keep in [100, 100_000] {
        let chunked = build_keep(&start, &sizes, &cmxs, &ours, 400, false, keep);
        let sub = build_keep(&start, &sizes, &cmxs, &ours, 400, true, keep);
        assert_eq!(chunked.root().unwrap(), sub.root().unwrap());
        assert_eq!(
            chunked.checkpoint_ids().unwrap(),
            sub.checkpoint_ids().unwrap()
        );
        // Every 13th checkpoint and the newest (a root at a checkpoint is the slow read).
        let ids = sub.checkpoint_ids().unwrap();
        for id in ids.iter().copied().step_by(13).chain(ids.last().copied()) {
            assert_eq!(
                chunked.root_at_block(id).unwrap(),
                sub.root_at_block(id).unwrap(),
                "root at block {id}, keep {keep}"
            );
        }
        assert_eq!(chunked.witnesses().unwrap(), sub.witnesses().unwrap());
        assert_eq!(
            sub.subtrees_inserted(),
            n.div_ceil(SUBTREE_LEAVES) as u64,
            "pieces of 1,024 leaves"
        );
        assert_eq!(
            sub.batch_inserts(),
            0,
            "the subtrees mode makes no batch_insert"
        );
        assert_eq!(
            chunked.subtrees_inserted(),
            0,
            "the chunked mode builds no subtree"
        );
        assert_eq!(
            chunked.batch_inserts(),
            1,
            "one batch_insert for the one chunk"
        );
    }
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
    // Against the chunked default (tests/tree_insert.rs ties chunked to per-block), which keeps this test fast.
    let per_block = run(TreeInsert::DEFAULT);
    let sub = run(TreeInsert::from_name("subtrees").unwrap());
    for p in 0..2 {
        assert_eq!(sub.root_bytes(p).unwrap(), per_block.root_bytes(p).unwrap());
    }
    assert!(sub.summary().contains("\"tree_insert\":\"subtrees-10000\""));
    let (pieces, batches) = sub.tree_insert_counts();
    assert!(pieces >= 2, "the scan built its subtrees ({pieces})");
    assert_eq!(batches, 0, "and made no batch_insert");
    assert_eq!(per_block.tree_insert_counts().0, 0);
}
