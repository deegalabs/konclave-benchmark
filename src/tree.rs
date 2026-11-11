// SPDX-License-Identifier: MIT OR Apache-2.0
//! The note commitment tree of one pool: a shard tree with a checkpoint per block, and witnesses for the notes that are
//! ours. Orchard and Ironwood each have their own tree and share the Orchard hash. Commitments go in with one
//! `batch_insert` per chunk of blocks (`TreeInsert`); a chunk of one block is the per-block mode.
use incrementalmerkletree::{
    frontier::{CommitmentTree, Frontier},
    Address, Hashable, Level, Position, Retention,
};
use orchard::tree::MerkleHashOrchard;
use shardtree::{
    store::{memory::MemoryShardStore, Checkpoint, ShardStore},
    LocatedPrunableTree, ShardTree,
};
use std::collections::VecDeque;

pub const DEPTH: u8 = 32;
const SHARD_HEIGHT: u8 = 16;
pub const MAX_CHECKPOINTS: usize = 100;
/// Blocks per `batch_insert` in the default mode.
pub const CHUNK_BLOCKS: usize = 10_000;
type Tree = ShardTree<MemoryShardStore<MerkleHashOrchard, u64>, 32, SHARD_HEIGHT>;

/// How a scan puts the commitments of a range into the tree: one `batch_insert` per chunk of this many blocks, with a
/// checkpoint kept for every block either way. `Chunked(1)` is `PerBlock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TreeInsert {
    Chunked(usize),
    PerBlock,
}

impl TreeInsert {
    pub const DEFAULT: TreeInsert = TreeInsert::Chunked(CHUNK_BLOCKS);

    /// Blocks per `batch_insert`.
    pub fn chunk_blocks(self) -> usize {
        match self {
            TreeInsert::Chunked(n) => n.max(1),
            TreeInsert::PerBlock => 1,
        }
    }

    /// The text every result records: `chunk-10000` or `per-block`.
    pub fn label(self) -> String {
        match self {
            TreeInsert::Chunked(n) => format!("chunk-{}", n.max(1)),
            TreeInsert::PerBlock => "per-block".to_string(),
        }
    }

    /// The page's word for the mode: `chunked` (the default) or `per-block`.
    pub fn from_name(name: &str) -> Result<TreeInsert, String> {
        match name {
            "chunked" => Ok(TreeInsert::DEFAULT),
            "per-block" => Ok(TreeInsert::PerBlock),
            _ => Err("tree insertion is chunked or per-block".to_string()),
        }
    }
}

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
                Option::<MerkleHashOrchard>::from(MerkleHashOrchard::from_bytes(
                    h.try_into().unwrap(),
                ))
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
    max_checkpoints: usize,
    /// Ids of the checkpoints the tree keeps, oldest first, so a block does not have to read the store.
    kept: VecDeque<u64>,
    empty_added: u64,
    /// Position of the last leaf in the tree so far (the frontier's, before the first leaf of the range).
    tip: Option<Position>,
    start_root: MerkleHashOrchard,
    marked: Vec<(Position, MerkleHashOrchard)>,
}

impl PoolTree {
    pub fn new(start: Frontier<MerkleHashOrchard, 32>) -> Result<PoolTree, String> {
        Self::with_max_checkpoints(start, MAX_CHECKPOINTS)
    }

    /// As `new`, keeping this many checkpoints (a test keeps them all).
    pub fn with_max_checkpoints(
        start: Frontier<MerkleHashOrchard, 32>,
        max_checkpoints: usize,
    ) -> Result<PoolTree, String> {
        let mut tree = Tree::new(MemoryShardStore::empty(), max_checkpoints);
        let next = start.tree_size();
        let start_root = start.root();
        let tip = start.value().map(|f| f.position());
        tree.insert_frontier(start, Retention::Ephemeral)
            .map_err(|e| format!("{e:?}"))?;
        Ok(PoolTree {
            tree,
            next,
            start_size: next,
            next_checkpoint: 0,
            max_checkpoints,
            kept: VecDeque::new(),
            empty_added: 0,
            tip,
            start_root,
            marked: Vec::new(),
        })
    }

    pub fn size(&self) -> u64 {
        self.next
    }

    pub fn start_size(&self) -> u64 {
        self.start_size
    }

    /// The commitments of several blocks in one `batch_insert`. `ends[b]` is where block b ends in `cmxs`, so a block
    /// with no commitments repeats the end before it. Every block gets a checkpoint, with the block's index in the
    /// range as its id: a block that has commitments carries it on its last leaf, as `Retention::Checkpoint`; the
    /// notes that are ours stay `Marked`.
    ///
    /// A block with none gets its checkpoint at the position of the last leaf before it (the frontier's when no leaf
    /// came yet, or the empty tree). That position rule is the one `ensure_checkpoints` (zcash_client_backend,
    /// data_api/ll/wallet.rs) uses for a height at which the pool has no commitment but another pool has one, or
    /// which an anchor-retention policy keeps; that function does not checkpoint a block that is empty in every
    /// pool. Giving every block a checkpoint is this harness's own choice, so that the checkpoints of the two
    /// insertion modes can be compared.
    ///
    /// The checkpoints of empty blocks are added after the insert, and the tree is pruned to `max_checkpoints`
    /// again after them (an insert of an empty subtree for the ones that have a position, which prunes as any
    /// insert does). A block older than the newest `max_checkpoints` of the ones held and these is skipped.
    pub fn append_chunk(
        &mut self,
        cmxs: &[MerkleHashOrchard],
        ours: &[bool],
        ends: &[usize],
    ) -> Result<(), String> {
        if ours.len() != cmxs.len() || ends.last().is_some_and(|e| *e != cmxs.len()) {
            return Err("a chunk's commitments, flags and block ends disagree".into());
        }
        let first_id = self.next_checkpoint;
        let mut leaves = Vec::with_capacity(cmxs.len());
        let mut empty: Vec<(u64, Option<Position>)> = Vec::new();
        let mut nonempty: Vec<u64> = Vec::new();
        let mut at = 0usize;
        for (b, end) in ends.iter().enumerate() {
            let id = first_id + b as u64;
            if *end < at {
                return Err("block ends go backwards".into());
            }
            if *end == at {
                empty.push((id, self.tip));
                continue;
            }
            for i in at..*end {
                let marking = if ours[i] {
                    incrementalmerkletree::Marking::Marked
                } else {
                    incrementalmerkletree::Marking::None
                };
                let retention = if i + 1 == *end {
                    Retention::Checkpoint { id, marking }
                } else if ours[i] {
                    Retention::Marked
                } else {
                    Retention::Ephemeral
                };
                leaves.push((cmxs[i], retention));
            }
            nonempty.push(id);
            self.tip = Some(Position::from(self.next + *end as u64 - 1));
            at = *end;
        }
        if !leaves.is_empty() {
            self.tree
                .batch_insert(Position::from(self.next), leaves.into_iter())
                .map_err(|e| format!("{e:?}"))?;
        }
        let keep = self.max_checkpoints.max(1);
        let mut added: Vec<u64> = nonempty;
        if !empty.is_empty() {
            // The checkpoints the tree will keep are the newest `keep` of those held (`self.kept`) and the ones of this
            // chunk. An empty block older than that is skipped.
            let mut all: Vec<u64> = added
                .iter()
                .copied()
                .chain(empty.iter().map(|e| e.0))
                .collect();
            all.sort_unstable();
            let total = self.kept.len() + all.len();
            let floor = if total > keep {
                let at = total - keep;
                if at < self.kept.len() {
                    self.kept[at]
                } else {
                    all[at - self.kept.len()]
                }
            } else {
                0
            };
            let mut positioned = std::collections::BTreeMap::new();
            for (id, tip) in empty {
                if id < floor {
                    continue;
                }
                added.push(id);
                self.empty_added += 1;
                match tip {
                    Some(pos) => {
                        positioned.insert(id, pos);
                    }
                    None => self
                        .tree
                        .store_mut()
                        .add_checkpoint(id, Checkpoint::tree_empty())
                        .map_err(|e| format!("{e:?}"))?,
                }
            }
            if !positioned.is_empty() {
                // No leaves: only the checkpoints are added, and the tree prunes to its maximum.
                let none =
                    LocatedPrunableTree::empty(Address::from_parts(Level::from(SHARD_HEIGHT), 0));
                self.tree
                    .insert_tree(none, positioned)
                    .map_err(|e| format!("{e:?}"))?;
            }
            added.sort_unstable();
        }
        self.kept.extend(added);
        while self.kept.len() > keep {
            if let Some(old) = self.kept.pop_front() {
                // Already gone when the tree pruned it; only a checkpoint with no position can still be there.
                self.tree
                    .store_mut()
                    .remove_checkpoint(&old)
                    .map_err(|e| format!("{e:?}"))?;
            }
        }
        for (i, h) in cmxs.iter().enumerate() {
            if ours[i] {
                self.marked.push((Position::from(self.next + i as u64), *h));
            }
        }
        self.next += cmxs.len() as u64;
        self.next_checkpoint += ends.len() as u64;
        Ok(())
    }

    /// The root at the checkpoint of block `id` (its index in the range), if that checkpoint is still kept.
    pub fn root_at_block(&self, id: u64) -> Result<Option<MerkleHashOrchard>, String> {
        self.tree
            .root_at_checkpoint_id(&id)
            .map_err(|e| format!("{e:?}"))
    }

    /// How many checkpoints of blocks with no commitments were added to the tree (a test reads it).
    pub fn empty_checkpoints_added(&self) -> u64 {
        self.empty_added
    }

    /// The ids of the checkpoints kept, oldest first.
    pub fn checkpoint_ids(&self) -> Result<Vec<u64>, String> {
        let mut ids = Vec::new();
        self.tree
            .store()
            .for_each_checkpoint(usize::MAX, |id, _| {
                ids.push(*id);
                Ok(())
            })
            .map_err(|e| format!("{e:?}"))?;
        Ok(ids)
    }

    /// The witness of the note at `pos` at the checkpoint of block `id`, as its root over `leaf`.
    pub fn witness_root_at_block(
        &self,
        pos: Position,
        leaf: MerkleHashOrchard,
        id: u64,
    ) -> Result<Option<MerkleHashOrchard>, String> {
        let path = self
            .tree
            .witness_at_checkpoint_id(pos, &id)
            .map_err(|e| format!("{e:?}"))?;
        Ok(path.map(|p| p.root(leaf)))
    }

    /// The notes kept, with their positions.
    pub fn marked(&self) -> &[(Position, MerkleHashOrchard)] {
        &self.marked
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
