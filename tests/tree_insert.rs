// SPDX-License-Identifier: MIT OR Apache-2.0
//! Chunked insertion against per-block insertion: the same roots at every checkpoint, the same final root, the same
//! witnesses for every note kept, whatever the chunk size and wherever a chunk ends.
use incrementalmerkletree::{frontier::Frontier, Position};
use konclave_benchmark::{
    scan::Scan,
    synth::{self, Params},
    tree::{PoolTree, TreeInsert, CHUNK_BLOCKS},
};
use orchard::tree::MerkleHashOrchard;
use rand::{rngs::StdRng, Rng, SeedableRng};

fn leaf(rng: &mut StdRng) -> MerkleHashOrchard {
    let mut b = [0u8; 32];
    rng.fill_bytes(&mut b[..31]);
    MerkleHashOrchard::from_bytes(&b).unwrap()
}

/// A start state at `pos` (not empty), with made-up nodes: both modes read the same ones, so the roots are comparable with
/// each other. Shards hold 65,536 leaves, so 65,533 to 65,536 are the starts next to a shard boundary.
fn start_at(pos: u64, rng: &mut StdRng) -> Frontier<MerkleHashOrchard, 32> {
    let position = Position::from(pos);
    let ommers = (0..position.past_ommer_count())
        .map(|_| leaf(rng))
        .collect();
    Frontier::from_parts(position, leaf(rng), ommers).unwrap()
}

fn start_near_shard_end(rng: &mut StdRng) -> Frontier<MerkleHashOrchard, 32> {
    start_at(65_533, rng)
}

/// What a range holds: leaves per block (a zero is a block with no commitments), and which leaves are ours.
struct Range {
    sizes: Vec<usize>,
    ours: Vec<bool>,
    cmxs: Vec<MerkleHashOrchard>,
}

/// Blocks of 0 to 4 commitments with runs of empty blocks: at the start, around a chunk boundary of 7, and at the end. The last
/// leaf of block 6 (the last of the first chunk of 7) and of block 20 (the last of the third) are ours, as are some others.
fn range(blocks: usize, rng: &mut StdRng) -> Range {
    let mut sizes = Vec::new();
    for b in 0..blocks {
        let empty =
            b < 2 || (5..10).contains(&b) || (30..34).contains(&b) || b + 3 >= blocks || b % 4 == 3;
        sizes.push(if empty { 0 } else { 1 + (b * 7) % 4 });
    }
    sizes[6] = 3;
    sizes[20] = 2;
    let n: usize = sizes.iter().sum();
    let mut ours = vec![false; n];
    let mut end = 0;
    for (b, s) in sizes.iter().enumerate() {
        end += s;
        if (b == 6 || b == 20) && *s > 0 {
            ours[end - 1] = true;
        }
    }
    for i in (0..n).step_by(11) {
        ours[i] = true;
    }
    Range {
        sizes,
        ours,
        cmxs: (0..n).map(|_| leaf(rng)).collect(),
    }
}

fn build(
    start: &Frontier<MerkleHashOrchard, 32>,
    r: &Range,
    chunk: usize,
    keep: usize,
) -> PoolTree {
    let mut t = PoolTree::with_max_checkpoints(start.clone(), keep).unwrap();
    let mut at = 0;
    for blocks in r.sizes.chunks(chunk) {
        let total: usize = blocks.iter().sum();
        let mut ends = Vec::new();
        let mut e = 0;
        for s in blocks {
            e += s;
            ends.push(e);
        }
        t.append_chunk(&r.cmxs[at..at + total], &r.ours[at..at + total], &ends)
            .unwrap();
        at += total;
    }
    t
}

fn same(a: &PoolTree, b: &PoolTree, ids: std::ops::Range<u64>) {
    assert_eq!(a.size(), b.size());
    assert_eq!(a.root().unwrap(), b.root().unwrap(), "the final root");
    for id in ids {
        let (ra, rb) = (a.root_at_block(id).unwrap(), b.root_at_block(id).unwrap());
        assert!(ra.is_some(), "no checkpoint {id} in the per-block tree");
        assert_eq!(ra, rb, "the root at the checkpoint of block {id}");
    }
    assert_eq!(a.marked(), b.marked());
    assert_eq!(a.witnesses().unwrap(), b.witnesses().unwrap());
}

/// Every note kept has the same witness at the checkpoints from its own block on.
fn same_witnesses(a: &PoolTree, b: &PoolTree, ids: std::ops::Range<u64>) {
    for (pos, h) in a.marked() {
        for id in ids.clone() {
            let (wa, wb) = (
                a.witness_root_at_block(*pos, *h, id),
                b.witness_root_at_block(*pos, *h, id),
            );
            assert_eq!(wa.is_ok(), wb.is_ok(), "witness of {pos:?} at block {id}");
            if let (Ok(Some(x)), Ok(y)) = (wa, wb) {
                assert_eq!(Some(x), y, "witness of {pos:?} at block {id}");
                assert_eq!(
                    Some(x),
                    a.root_at_block(id).unwrap(),
                    "does not reach the root"
                );
            }
        }
    }
}

#[test]
fn chunks_and_per_block_give_the_same_root_at_every_checkpoint_and_the_same_witnesses() {
    let mut rng = StdRng::seed_from_u64(1);
    let r = range(48, &mut rng);
    let blocks = r.sizes.len() as u64;
    for start in [Frontier::empty(), start_near_shard_end(&mut rng)] {
        let per_block = build(&start, &r, 1, 1000);
        assert_eq!(
            per_block.checkpoint_ids().unwrap(),
            (0..blocks).collect::<Vec<_>>()
        );
        for chunk in [2, 7, 10, 48, 100] {
            let chunked = build(&start, &r, chunk, 1000);
            assert_eq!(
                chunked.checkpoint_ids().unwrap(),
                (0..blocks).collect::<Vec<_>>(),
                "chunk {chunk}: a checkpoint per block"
            );
            same(&per_block, &chunked, 0..blocks);
            same_witnesses(&per_block, &chunked, 0..blocks);
            // Not only the same as per-block: a block with no commitments has the root the tree had before it.
            for (b, size) in r.sizes.iter().enumerate() {
                if *size == 0 {
                    let before = if b == 0 {
                        Some(start.root())
                    } else {
                        chunked.root_at_block(b as u64 - 1).unwrap()
                    };
                    assert_eq!(
                        chunked.root_at_block(b as u64).unwrap(),
                        before,
                        "empty block {b}"
                    );
                }
            }
        }
    }
}

#[test]
fn the_checkpoints_the_scan_reads_survive_pruning() {
    let mut rng = StdRng::seed_from_u64(2);
    let r = range(48, &mut rng);
    let blocks = r.sizes.len() as u64;
    for start in [Frontier::empty(), start_near_shard_end(&mut rng)] {
        for keep in [3, 10] {
            let per_block = build(&start, &r, 1, keep);
            for chunk in [7, 10, 48] {
                let chunked = build(&start, &r, chunk, keep);
                // The newest `keep` blocks have their checkpoint in both, and the root and witnesses at depth 0 are the same.
                same(&per_block, &chunked, blocks - keep as u64..blocks);
                same_witnesses(&per_block, &chunked, blocks - keep as u64..blocks);
                assert!(
                    chunked.checkpoint_ids().unwrap().len()
                        <= keep + r.sizes.iter().filter(|s| **s == 0).count()
                );
            }
        }
    }
}

#[test]
fn a_range_of_only_empty_blocks_has_its_checkpoints_at_the_start_state() {
    let mut rng = StdRng::seed_from_u64(3);
    for start in [Frontier::empty(), start_near_shard_end(&mut rng)] {
        let root = start.root();
        for chunk in [1, 4, 9] {
            let mut t = PoolTree::new(start.clone()).unwrap();
            for _ in 0..9usize.div_ceil(chunk) {
                let n = chunk.min(9);
                t.append_chunk(&[], &[], &vec![0; n]).unwrap();
            }
            assert_eq!(t.root().unwrap(), root);
            let last = t
                .root_at_block(8.min(t.checkpoint_ids().unwrap().last().copied().unwrap()))
                .unwrap();
            assert_eq!(last, Some(root));
        }
    }
}

fn scan(file: &[u8], mode: TreeInsert) -> Scan {
    let mut s = Scan::from_corpus(file).unwrap();
    s.set_tree_insert_mode(mode).unwrap();
    s.decode_inner().unwrap();
    s.decrypt_inner().unwrap();
    s.tree_inner().unwrap();
    s.witness_inner().unwrap();
    s
}

#[test]
fn a_scan_gives_the_same_roots_and_witnesses_in_every_mode_and_records_the_mode() {
    let file = synth::generate(Params {
        blocks: 53,
        txs_per_block: 1,
        actions_per_tx: 3,
        ours_every: 2,
        ..Default::default()
    });
    let per_block = scan(&file, TreeInsert::PerBlock);
    assert!(per_block
        .summary()
        .contains("\"tree_insert\":\"per-block\""));
    for mode in [
        TreeInsert::Chunked(7),
        TreeInsert::Chunked(1000),
        TreeInsert::DEFAULT,
    ] {
        let s = scan(&file, mode);
        for p in 0..2 {
            assert_eq!(s.root_bytes(p).unwrap(), per_block.root_bytes(p).unwrap());
        }
        assert!(s
            .summary()
            .contains(&format!("\"tree_insert\":\"{}\"", mode.label())));
    }
    assert!(scan(&file, TreeInsert::DEFAULT)
        .summary()
        .contains("\"tree_insert\":\"chunk-10000\""));
}

/// The real chunk size over a range of three chunks. Blocks 9,997 to 10,003 are empty, so the first boundary is inside a run of
/// empty blocks; block 19,999, the last of the second chunk, ends with a note of ours, and block 15,000 has one in its middle.
#[test]
fn the_real_chunk_size_over_three_chunks_agrees_with_per_block() {
    let mut rng = StdRng::seed_from_u64(4);
    let blocks = 25_000;
    let mut sizes = Vec::new();
    for b in 0..blocks {
        let empty = b % 6 >= 2 || (9_997..=10_003).contains(&b) || b + 2 >= blocks;
        sizes.push(if empty { 0 } else { 1 + b % 2 });
    }
    sizes[19_999] = 2;
    sizes[15_000] = 3;
    let n: usize = sizes.iter().sum();
    let mut ours = vec![false; n];
    let mut end = 0;
    for (b, s) in sizes.iter().enumerate() {
        end += s;
        if b == 19_999 || b == 5_004 || b == 24_990 {
            ours[end - 1] = true;
        }
        if b == 15_000 {
            ours[end - 2] = true;
        }
    }
    let r = Range {
        sizes,
        ours,
        cmxs: (0..n).map(|_| leaf(&mut rng)).collect(),
    };
    let start = Frontier::empty();
    let per_block = build(&start, &r, 1, 100);
    let chunked = build(&start, &r, CHUNK_BLOCKS, 100);
    assert_eq!(per_block.marked().len(), 4);
    same(&per_block, &chunked, blocks as u64 - 100..blocks as u64);
    same_witnesses(&per_block, &chunked, blocks as u64 - 100..blocks as u64);
}

/// A range of `blocks` blocks around the chunk size: every fifth block has one commitment, and the last leaf of block 9,999 (the
/// end of chunk 1), the first leaf of block 10,000 (the start of chunk 2) and the last leaf of the range are ours.
/// `all_empty` leaves every block without commitments.
fn edge_range(blocks: usize, all_empty: bool, rng: &mut StdRng) -> Range {
    let mut sizes = vec![0usize; blocks];
    if !all_empty {
        for (b, s) in sizes.iter_mut().enumerate() {
            *s = usize::from(b % 5 == 0);
        }
        for b in [9_998usize, 9_999, 10_000, blocks - 1] {
            if b < blocks {
                sizes[b] = 2;
            }
        }
    }
    let n: usize = sizes.iter().sum();
    let mut ours = vec![false; n];
    let mut end = 0;
    for (b, s) in sizes.iter().enumerate() {
        let begin = end;
        end += s;
        if *s > 0 && (b == 9_999 || b + 1 == blocks) {
            ours[end - 1] = true;
        }
        if *s > 0 && b == 10_000 {
            ours[begin] = true;
        }
    }
    Range {
        sizes,
        ours,
        cmxs: (0..n).map(|_| leaf(rng)).collect(),
    }
}

/// Ranges of 9,999, 10,000 and 10,001 blocks (one short of a chunk, exactly one, one over), empty and mixed, from the starts
/// next to a shard boundary and from an empty tree, with the real chunk size and the real number of checkpoints.
#[test]
fn ranges_at_the_chunk_size_agree_with_per_block_from_every_start_next_to_a_shard_boundary() {
    let mut rng = StdRng::seed_from_u64(5);
    for blocks in [9_999usize, 10_000, 10_001] {
        let top = blocks as u64;
        for all_empty in [true, false] {
            let r = edge_range(blocks, all_empty, &mut rng);
            let mut starts = vec![Frontier::empty()];
            starts.extend((65_533..=65_536).map(|p| start_at(p, &mut rng)));
            for start in starts {
                let per_block = build(&start, &r, 1, 100);
                let chunked = build(&start, &r, CHUNK_BLOCKS, 100);
                assert!(chunked.checkpoint_ids().unwrap().len() <= 100);
                same(&per_block, &chunked, top - 100..top);
                same_witnesses(&per_block, &chunked, top - 100..top);
            }
        }
    }
}

/// A pool with no commitments for 50,000 blocks (the likely case for a thin pool): the work and the checkpoints kept stay
/// bounded in both modes, from an empty tree and from a start state. Both keep at most the maximum, chunked included.
#[test]
fn fifty_thousand_empty_blocks_cost_little_and_keep_at_most_the_maximum() {
    let mut rng = StdRng::seed_from_u64(6);
    let r = Range {
        sizes: vec![0; 50_000],
        ours: Vec::new(),
        cmxs: Vec::new(),
    };
    for start in [Frontier::empty(), start_at(65_534, &mut rng)] {
        for chunk in [1, CHUNK_BLOCKS] {
            let t0 = std::time::Instant::now();
            let t = build(&start, &r, chunk, 100);
            let took = t0.elapsed().as_secs_f64();
            assert!(
                took < 30.0,
                "chunk {chunk}: {took:.2} s for 50,000 empty blocks"
            );
            let ids = t.checkpoint_ids().unwrap();
            assert!(
                ids.len() <= 100,
                "chunk {chunk}: {} checkpoints kept",
                ids.len()
            );
            assert_eq!(ids.last(), Some(&49_999));
            assert_eq!(t.root().unwrap(), start.root());
        }
    }
}

/// The skip rule: an empty block older than the checkpoints kept is not added at all.
#[test]
fn an_empty_block_older_than_the_checkpoints_kept_is_not_added() {
    let mut rng = StdRng::seed_from_u64(7);
    let start = start_at(65_534, &mut rng);
    let mut t = PoolTree::with_max_checkpoints(start, 10).unwrap();
    t.append_chunk(&[], &[], &[0; 1_000]).unwrap();
    assert_eq!(
        t.empty_checkpoints_added(),
        10,
        "of 1,000 empty blocks only the newest 10 are added"
    );
    assert_eq!(
        t.checkpoint_ids().unwrap(),
        (990..1_000).collect::<Vec<_>>()
    );
}

#[test]
fn the_mode_is_chosen_before_the_scan_starts_and_by_name() {
    let file = synth::generate(Params {
        blocks: 4,
        ..Default::default()
    });
    let mut s = Scan::from_corpus(&file).unwrap();
    assert!(s.set_tree_insert_inner("one at a time").is_err());
    s.set_tree_insert_inner("per-block").unwrap();
    s.set_tree_insert_inner("chunked").unwrap();
    s.decode_inner().unwrap();
    assert!(s.set_tree_insert_inner("per-block").is_err());
    assert_eq!(
        TreeInsert::from_name("chunked").unwrap().label(),
        "chunk-10000"
    );
}
