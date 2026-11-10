// SPDX-License-Identifier: MIT OR Apache-2.0
//! The note commitment tree of one pool, the way a wallet keeps it: a shard tree, a checkpoint per block, witnesses for
//! the notes that are ours. Orchard and Ironwood each have their own tree and share the Orchard hash.
use incrementalmerkletree::{
    frontier::{CommitmentTree, Frontier},
    Hashable, Level, Position, Retention,
};
use orchard::tree::MerkleHashOrchard;
use shardtree::{store::memory::MemoryShardStore, ShardTree};

pub const DEPTH: u8 = 32;
const SHARD_HEIGHT: u8 = 16;
const MAX_CHECKPOINTS: usize = 100;
type Tree = ShardTree<MemoryShardStore<MerkleHashOrchard, u64>, 32, SHARD_HEIGHT>;

/// Reads the tree state lightwalletd returns from GetTreeState: optional left, optional right, a vector of optional
/// parents. tests/wire.rs checks this against zcash_primitives.
pub fn parse_legacy(bytes: &[u8]) -> Result<Frontier<MerkleHashOrchard, 32>, String> {
    if bytes.is_empty() {
        return Ok(Frontier::empty());
    }
    let mut p = bytes;
    let opt = |p: &mut &[u8]| -> Result<Option<MerkleHashOrchard>, String> {
        let (flag, rest) = p.split_first().ok_or("tree state ends early")?;
        *p = rest;
        match flag {
            0 => Ok(None),
            1 => {
                if p.len() < 32 {
                    return Err("tree state ends early".into());
                }
                let (h, rest) = p.split_at(32);
                *p = rest;
                Option::<MerkleHashOrchard>::from(MerkleHashOrchard::from_bytes(h.try_into().unwrap()))
                    .map(Some)
                    .ok_or_else(|| "invalid node in tree state".to_string())
            }
            _ => Err("invalid flag in tree state".into()),
        }
    };
    let left = opt(&mut p)?;
    let right = opt(&mut p)?;
    let (n, rest) = p.split_first().ok_or("tree state ends early")?;
    if *n >= 0xfd {
        return Err("tree state has too many parents".into());
    }
    p = rest;
    let mut parents = Vec::new();
    for _ in 0..*n {
        parents.push(opt(&mut p)?);
    }
    if !p.is_empty() {
        return Err("tree state has trailing bytes".into());
    }
    let t = CommitmentTree::<MerkleHashOrchard, 32>::from_parts(left, right, parents)
        .map_err(|_| "invalid tree state".to_string())?;
    Ok(t.to_frontier())
}

pub struct PoolTree {
    tree: Tree,
    next: u64,
    start_size: u64,
    next_checkpoint: u64,
    start_root: MerkleHashOrchard,
    marked: Vec<(Position, MerkleHashOrchard)>,
}

impl PoolTree {
    pub fn new(start: Frontier<MerkleHashOrchard, 32>) -> Result<PoolTree, String> {
        let mut tree = Tree::new(MemoryShardStore::empty(), MAX_CHECKPOINTS);
        let next = start.tree_size();
        let start_root = start.root();
        tree.insert_frontier(start, Retention::Ephemeral).map_err(|e| format!("{e:?}"))?;
        Ok(PoolTree { tree, next, start_size: next, next_checkpoint: 0, start_root, marked: Vec::new() })
    }

    pub fn size(&self) -> u64 {
        self.next
    }

    pub fn start_size(&self) -> u64 {
        self.start_size
    }

    /// One block's commitments, in chain order; the flags say which positions in this slice to keep a witness for.
    pub fn append_block(&mut self, cmxs: &[MerkleHashOrchard], ours: &[bool]) -> Result<(), String> {
        if cmxs.is_empty() {
            return Ok(());
        }
        let last = cmxs.len() - 1;
        let id = self.next_checkpoint;
        let start = Position::from(self.next);
        let leaves = cmxs.iter().enumerate().map(|(i, h)| {
            let marking = if ours[i] { incrementalmerkletree::Marking::Marked } else { incrementalmerkletree::Marking::None };
            let retention = if i == last {
                Retention::Checkpoint { id, marking }
            } else if ours[i] {
                Retention::Marked
            } else {
                Retention::Ephemeral
            };
            (*h, retention)
        });
        self.tree.batch_insert(start, leaves).map_err(|e| format!("{e:?}"))?;
        for (i, h) in cmxs.iter().enumerate() {
            if ours[i] {
                self.marked.push((Position::from(self.next + i as u64), *h));
            }
        }
        self.next += cmxs.len() as u64;
        self.next_checkpoint += 1;
        Ok(())
    }

    pub fn root(&self) -> Result<MerkleHashOrchard, String> {
        if self.next_checkpoint == 0 {
            return Ok(self.start_root);
        }
        self.tree
            .root_at_checkpoint_depth(Some(0))
            .map_err(|e| format!("{e:?}"))?
            .ok_or_else(|| "no root at the last checkpoint".to_string())
    }

    /// Computes a witness for every note kept, and checks each one reaches the root. Returns how many.
    pub fn witnesses(&self) -> Result<u32, String> {
        let root = self.root()?;
        for (pos, leaf) in &self.marked {
            let path = self
                .tree
                .witness_at_checkpoint_depth(*pos, 0)
                .map_err(|e| format!("{e:?}"))?
                .ok_or("no witness for a kept note")?;
            if path.root(*leaf) != root {
                return Err("a witness does not reach the root".into());
            }
        }
        Ok(self.marked.len() as u32)
    }
}

pub fn empty_root() -> MerkleHashOrchard {
    MerkleHashOrchard::empty_root(Level::from(DEPTH))
}
