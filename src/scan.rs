// SPDX-License-Identifier: MIT OR Apache-2.0
//! The CPU work of a light-client scan, stage by stage, so the page can time each: decode the block messages, try every
//! action of both pools with the internal and the external viewing key, keep each pool's commitment tree and the
//! witnesses of the notes found.
//!
//! Not here: the download (the page times it), a wallet database, memos. So what this measures is
//! never called a sync. A Scan is single use: every run starts from the corpus's own state, never from an earlier
//! run's, so a later run cannot look faster by resuming.
use crate::{corpus, proto, tree};
use incrementalmerkletree::frontier::Frontier;
use orchard::{
    keys::{FullViewingKey, PreparedIncomingViewingKey, Scope, SpendingKey},
    note::{ExtractedNoteCommitment, Nullifier},
    note_encryption::{CompactAction, IronwoodDomain, OrchardDomain},
    tree::MerkleHashOrchard,
};
use prost::Message;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zcash_address::unified::{self, Container, Encoding};
use zcash_note_encryption::{batch::try_compact_note_decryption, EphemeralKeyBytes};

/// A batch decrypts together. At most this many; fewer when a pool is small, so a sparse range still splits into enough
/// batches for every thread. Both builds use the same rule, so threads change only who does the work.
const BATCH: usize = 1024;
const MIN_BATCH: usize = 64;

/// The batch for `n` actions shared by `threads`: four batches per thread, between MIN_BATCH and BATCH.
pub fn batch_for(n: usize, threads: usize) -> usize {
    n.div_ceil(threads.max(1) * 4).clamp(MIN_BATCH, BATCH)
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Stage {
    New,
    Decoded,
    Decrypted,
    Tree,
    Done,
}

struct Tx {
    filtered: [bool; 2],
    actions: [Vec<CompactAction>; 2],
}

/// How many start roots have been computed in this process. A test reads it to show that building a scan computes none.
pub static START_ROOTS_COMPUTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[wasm_bindgen]
pub struct Scan {
    stage: Stage,
    messages: Vec<Vec<u8>>,
    /// The length of each compact block message as it was given (pushed or loaded), kept after decode takes the messages: projection data only.
    message_sizes: Vec<u64>,
    start_height: u64,
    header: Option<corpus::Header>,
    corpus_sha256: Option<[u8; 32]>,
    txs: Vec<(usize, Tx)>,
    block_sizes: Vec<Option<[u32; 2]>>,
    keys: [PreparedIncomingViewingKey; 2],
    fvk: FullViewingKey,
    expected_end: Option<([u8; 32], [u8; 32])>,
    /// The tree states the scan starts from, kept to give the bare start roots in summary(), which no timer covers. A root is not
    /// computed when the scan is built: new_live runs inside the tree_state stage, whose time is part of the total.
    start_frontiers: [Frontier<MerkleHashOrchard, 32>; 2],
    batches: [usize; 2],
    chunks: [usize; 2],
    received_zat: u64,
    spent_zat: u64,
    filter: Option<u32>,
    action_counts: [u32; 2],
    found: [[u32; 2]; 2],
    /// Per pool: whether the action at this index across the range is ours.
    ours: [Vec<bool>; 2],
    frontiers: [Option<Frontier<MerkleHashOrchard, 32>>; 2],
    trees: [Option<tree::PoolTree>; 2],
    /// sha256 of the viewing key text typed in, hex; None for the synthetic key. No part of the key is kept.
    key_sha256: Option<String>,
}

fn fixed_test_keys() -> Result<FullViewingKey, String> {
    let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes(crate::prove::KEY_SEED)).ok_or("bad seed")?;
    Ok(FullViewingKey::from(&sk))
}

fn prepared(fvk: &FullViewingKey) -> [PreparedIncomingViewingKey; 2] {
    [
        PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::External)),
        PreparedIncomingViewingKey::new(&fvk.to_ivk(Scope::Internal)),
    ]
}

fn decode_action(a: &proto::CompactOrchardAction) -> Result<CompactAction, String> {
    let nf: [u8; 32] = a.nullifier.as_slice().try_into().map_err(|_| "nullifier length")?;
    let cmx: [u8; 32] = a.cmx.as_slice().try_into().map_err(|_| "cmx length")?;
    let epk: [u8; 32] = a.ephemeral_key.as_slice().try_into().map_err(|_| "ephemeral key length")?;
    let enc: [u8; 52] = a.ciphertext.as_slice().try_into().map_err(|_| "ciphertext length")?;
    let nf = Option::<Nullifier>::from(Nullifier::from_bytes(&nf)).ok_or("invalid nullifier")?;
    let cmx = Option::<ExtractedNoteCommitment>::from(ExtractedNoteCommitment::from_bytes(&cmx)).ok_or("invalid cmx")?;
    Ok(CompactAction::from_parts(nf, cmx, EphemeralKeyBytes(epk), enc))
}

impl Scan {
    fn blank(start_height: u64, frontiers: [Frontier<MerkleHashOrchard, 32>; 2]) -> Result<Scan, String> {
        let fvk = fixed_test_keys()?;
        let start_frontiers = frontiers.clone();
        Ok(Scan {
            stage: Stage::New,
            messages: Vec::new(),
            message_sizes: Vec::new(),
            start_height,
            header: None,
            corpus_sha256: None,
            txs: Vec::new(),
            block_sizes: Vec::new(),
            keys: prepared(&fvk),
            fvk,
            expected_end: None,
            start_frontiers,
            batches: [0, 0],
            chunks: [0, 0],
            received_zat: 0,
            spent_zat: 0,
            filter: None,
            action_counts: [0, 0],
            found: [[0, 0], [0, 0]],
            ours: [Vec::new(), Vec::new()],
            frontiers: {
                let [a, b] = frontiers;
                [Some(a), Some(b)]
            },
            trees: [None, None],
            key_sha256: None,
        })
    }

    pub fn from_corpus(file: &[u8]) -> Result<Scan, String> {
        let (h, msgs, digest) = corpus::parse(file)?;
        let f = [tree::parse_legacy(&h.orchard_tree)?, tree::parse_legacy(&h.ironwood_tree)?];
        let mut s = Self::blank(h.start_height, f)?;
        s.messages = msgs.into_iter().map(|m| m.to_vec()).collect();
        s.message_sizes = s.messages.iter().map(|m| m.len() as u64).collect();
        s.corpus_sha256 = Some(digest);
        s.header = Some(h);
        Ok(s)
    }

    pub fn live(start_height: u64, orchard_tree: &[u8], ironwood_tree: &[u8]) -> Result<Scan, String> {
        Self::blank(start_height, [tree::parse_legacy(orchard_tree)?, tree::parse_legacy(ironwood_tree)?])
    }

    fn at(&self, want: Stage, name: &str) -> Result<(), String> {
        if self.stage != want {
            return Err(format!("{name} is out of order: a Scan runs each stage once, in order"));
        }
        Ok(())
    }

    pub fn push_message(&mut self, bytes: Vec<u8>) -> Result<(), String> {
        self.at(Stage::New, "push")?;
        if self.header.is_some() {
            return Err("a corpus scan takes no pushed blocks".into());
        }
        self.message_sizes.push(bytes.len() as u64);
        self.messages.push(bytes);
        Ok(())
    }

    /// Stage 1. Refuses a gap in the heights, and tree sizes that disagree with the actions present.
    pub fn decode_inner(&mut self) -> Result<u32, String> {
        self.at(Stage::New, "decode")?;
        let mut next_height = self.start_height;
        let mut prev: Option<Vec<u8>> = None;
        for (bi, m) in std::mem::take(&mut self.messages).iter().enumerate() {
            let b = proto::CompactBlock::decode(m.as_slice()).map_err(|e| format!("block {bi}: {e}"))?;
            if b.height != next_height {
                return Err(format!("expected block {next_height}, got {}", b.height));
            }
            next_height += 1;
            if let Some(p) = &prev {
                if *p != b.prev_hash {
                    return Err(format!("block {}: it does not follow the block before it", b.height));
                }
            }
            prev = Some(b.hash.clone());
            for t in &b.vtx {
                let mut actions: [Vec<CompactAction>; 2] = [Vec::new(), Vec::new()];
                for (p, list) in [&t.actions, &t.ironwood_actions].into_iter().enumerate() {
                    for a in list {
                        actions[p].push(decode_action(a).map_err(|e| format!("block {}: {e}", b.height))?);
                    }
                    self.action_counts[p] += list.len() as u32;
                }
                let filtered = [false, false];
                self.txs.push((bi, Tx { filtered, actions }));
            }
            self.block_sizes.push(b.chain_metadata.as_ref().map(|c| [c.orchard_commitment_tree_size, c.ironwood_commitment_tree_size]));
        }
        if let Some(h) = &self.header {
            if self.block_sizes.len() != h.blocks as usize {
                return Err("block count differs from the header".into());
            }
            if self.action_counts != [h.orchard_actions, h.ironwood_actions] {
                return Err(format!(
                    "action counts {:?} differ from the header ({}, {})",
                    self.action_counts, h.orchard_actions, h.ironwood_actions
                ));
            }
        }
        // Each block must end at the tree size it declares, starting from the state before the range.
        let mut size = [0u64; 2];
        for p in 0..2 {
            size[p] = self.frontiers[p].as_ref().unwrap().tree_size();
        }
        let mut i = 0;
        for (bi, declared) in self.block_sizes.iter().enumerate() {
            while i < self.txs.len() && self.txs[i].0 == bi {
                for p in 0..2 {
                    size[p] += self.txs[i].1.actions[p].len() as u64;
                }
                i += 1;
            }
            if let Some(d) = declared {
                for p in 0..2 {
                    if d[p] as u64 != size[p] {
                        return Err(format!("block {}: pool {p} tree size {} but counted {}", self.start_height + bi as u64, d[p], size[p]));
                    }
                }
            }
        }
        self.stage = Stage::Decoded;
        Ok(self.block_sizes.len() as u32)
    }

    fn decrypt_pool<D, F>(&mut self, p: usize, domain: F) -> Vec<Option<(usize, orchard::Note)>>
    where
        D: zcash_note_encryption::BatchDomain<IncomingViewingKey = PreparedIncomingViewingKey, Note = orchard::Note> + Send + Sync,
        D::Recipient: Send,
        F: Fn(&CompactAction) -> D + Sync,
        CompactAction: zcash_note_encryption::ShieldedOutput<D>,
    {
        let mut pairs: Vec<(usize, &CompactAction)> = Vec::new();
        let mut index = 0usize;
        for (_, t) in &self.txs {
            for a in &t.actions[p] {
                if !t.filtered[p] {
                    pairs.push((index, a));
                }
                index += 1;
            }
        }
        let mut out = vec![None; index];
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let run = |chunk: &[(usize, &CompactAction)]| -> Vec<(usize, usize, orchard::Note)> {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let outputs: Vec<(D, CompactAction)> = chunk.iter().map(|(_, a)| (domain(a), (*a).clone())).collect();
            try_compact_note_decryption(&self.keys, &outputs)
                .into_iter()
                .zip(chunk)
                .filter_map(|(r, (i, _))| r.map(|((note, _), k)| (*i, k, note)))
                .collect()
        };
        let batch = batch_for(pairs.len(), crate::thread_count() as usize);
        self.batches[p] = batch;
        #[cfg(feature = "threads")]
        let hits: Vec<(usize, usize, orchard::Note)> = {
            use rayon::prelude::*;
            pairs.par_chunks(batch).flat_map_iter(|c| run(c)).collect()
        };
        #[cfg(not(feature = "threads"))]
        let hits: Vec<(usize, usize, orchard::Note)> = pairs.chunks(batch).flat_map(run).collect();
        // Counted where the work happens, so the summary reports the batches really made, not the rule's intent.
        self.chunks[p] = calls.into_inner();
        for (i, k, note) in hits {
            out[i] = Some((k, note));
        }
        out
    }

    /// Stage 2. Returns the notes found across both pools and both keys.
    pub fn decrypt_inner(&mut self) -> Result<u32, String> {
        self.at(Stage::Decoded, "decrypt")?;
        if let Some(limit) = self.filter {
            for (_, t) in &mut self.txs {
                for p in 0..2 {
                    t.filtered[p] = t.actions[p].len() as u32 > limit;
                }
            }
        }
        let results = [
            self.decrypt_pool::<OrchardDomain, _>(0, OrchardDomain::for_compact_action),
            self.decrypt_pool::<IronwoodDomain, _>(1, IronwoodDomain::for_compact_action),
        ];
        let mut total = 0;
        let mut notes = Vec::new();
        for (p, r) in results.iter().enumerate() {
            self.ours[p] = r.iter().map(Option::is_some).collect();
            for (k, note) in r.iter().flatten() {
                self.found[p][*k] += 1;
                total += 1;
                self.received_zat += note.value().inner();
                notes.push(note.clone());
            }
        }
        // A note is spent when its nullifier appears in an action of this range. Within the range only: a spend
        // before or after it is not seen, so this balance is the range's, and it is compared with a reference only
        // when the range starts at the vault's birthday and ends at the tip.
        let spent: std::collections::HashSet<[u8; 32]> =
            self.txs.iter().flat_map(|(_, t)| t.actions.iter().flatten()).map(|a| a.nullifier().to_bytes()).collect();
        for note in &notes {
            if spent.contains(&note.nullifier(&self.fvk).to_bytes()) {
                self.spent_zat += note.value().inner();
            }
        }
        if let Some(h) = &self.header {
            let flat = [self.found[0][0], self.found[0][1], self.found[1][0], self.found[1][1]];
            for (i, want) in h.expected.iter().enumerate() {
                if *want != corpus::UNKNOWN && *want != flat[i] && self.filter.is_none() {
                    return Err(format!("expected notes {:?}, found {flat:?}", h.expected));
                }
            }
        }
        self.stage = Stage::Decrypted;
        Ok(total)
    }

    /// Stage 3. Appends every commitment of the range, block by block, and refuses a root that differs from the
    /// corpus's. Returns the commitments appended.
    pub fn tree_inner(&mut self) -> Result<u32, String> {
        self.at(Stage::Decrypted, "tree")?;
        let mut count = 0;
        for p in 0..2 {
            let mut t = tree::PoolTree::new(self.frontiers[p].take().unwrap())?;
            let mut offset = 0usize;
            let mut i = 0;
            for bi in 0..self.block_sizes.len() {
                let mut cmxs = Vec::new();
                let begin = offset;
                while i < self.txs.len() && self.txs[i].0 == bi {
                    for a in &self.txs[i].1.actions[p] {
                        cmxs.push(MerkleHashOrchard::from_cmx(&a.cmx()));
                        offset += 1;
                    }
                    i += 1;
                }
                t.append_block(&cmxs, &self.ours[p][begin..offset])?;
            }
            count += (t.size() - t.start_size()) as u32;
            self.trees[p] = Some(t);
        }
        if let Some((o, i)) = self.header.as_ref().and_then(|h| h.roots).or(self.expected_end) {
            for (p, want) in [o, i].iter().enumerate() {
                let got = self.trees[p].as_ref().unwrap().root()?.to_bytes();
                if got != *want {
                    return Err(format!("pool {p}: the tree root differs from the corpus root"));
                }
            }
        }
        self.stage = Stage::Tree;
        Ok(count)
    }

    /// Stage 4. A witness for every note found, each checked against the root.
    pub fn witness_inner(&mut self) -> Result<u32, String> {
        self.at(Stage::Tree, "witness")?;
        let n = self.trees[0].as_ref().unwrap().witnesses()? + self.trees[1].as_ref().unwrap().witnesses()?;
        self.stage = Stage::Done;
        Ok(n)
    }

    /// For a live range: the tree states the server gives for the end of the range. tree_inner refuses another root.
    pub fn set_expected_end_inner(&mut self, orchard_tree: &[u8], ironwood_tree: &[u8]) -> Result<(), String> {
        self.at(Stage::New, "set_expected_end")?;
        self.expected_end = Some((
            tree::parse_legacy(orchard_tree)?.root().to_bytes(),
            tree::parse_legacy(ironwood_tree)?.root().to_bytes(),
        ));
        Ok(())
    }

    pub fn start_is_empty(&self) -> bool {
        self.frontiers.iter().all(|f| f.as_ref().is_none_or(|f| f.tree_size() == 0))
    }

    pub fn set_filter_inner(&mut self, limit: u32) -> Result<(), String> {
        self.at(Stage::New, "set_filter")?;
        self.filter = Some(limit);
        Ok(())
    }

    pub fn set_ufvk_inner(&mut self, ufvk: &str) -> Result<String, String> {
        self.at(Stage::New, "set_ufvk")?;
        let (net, _, parsed) = unified::Ufvk::decode(ufvk).map_err(|e| format!("not a viewing key: {e}"))?;
        let orchard = parsed
            .items()
            .into_iter()
            .find_map(|i| if let unified::Fvk::Orchard(b) = i { Some(b) } else { None })
            .ok_or("this viewing key has no Orchard part")?;
        let fvk = FullViewingKey::from_bytes(&orchard).ok_or("invalid Orchard viewing key")?;
        self.keys = prepared(&fvk);
        self.fvk = fvk;
        self.key_sha256 = Some(Sha256::digest(ufvk.as_bytes()).iter().map(|b| format!("{b:02x}")).collect());
        Ok(format!("{net:?}"))
    }

    pub fn found_by_pool_and_key(&self) -> [[u32; 2]; 2] {
        self.found
    }

    pub fn received_and_spent(&self) -> (u64, u64) {
        (self.received_zat, self.spent_zat)
    }

    /// The bare 32-byte root of pool p's tree before the range.
    pub fn start_root_bytes(&self, p: usize) -> [u8; 32] {
        START_ROOTS_COMPUTED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.start_frontiers[p].root().to_bytes()
    }

    pub fn root_bytes(&self, p: usize) -> Result<[u8; 32], String> {
        Ok(self.trees[p].as_ref().ok_or("tree first")?.root()?.to_bytes())
    }
}

#[wasm_bindgen]
impl Scan {
    /// A saved range. Refuses a corpus whose hash does not match.
    #[wasm_bindgen(constructor)]
    pub fn new(corpus: &[u8]) -> Result<Scan, JsError> {
        Self::from_corpus(corpus).map_err(|e| JsError::new(&e))
    }
    /// A range the page downloads and pushes block by block. The trees are the bytes GetTreeState returns.
    pub fn new_live(start_height: u64, orchard_tree: &[u8], ironwood_tree: &[u8]) -> Result<Scan, JsError> {
        Self::live(start_height, orchard_tree, ironwood_tree).map_err(|e| JsError::new(&e))
    }
    pub fn push(&mut self, block: Vec<u8>) -> Result<(), JsError> {
        self.push_message(block).map_err(|e| JsError::new(&e))
    }
    pub fn decode(&mut self) -> Result<u32, JsError> {
        self.decode_inner().map_err(|e| JsError::new(&e))
    }
    pub fn decrypt(&mut self) -> Result<u32, JsError> {
        self.decrypt_inner().map_err(|e| JsError::new(&e))
    }
    pub fn tree(&mut self) -> Result<u32, JsError> {
        self.tree_inner().map_err(|e| JsError::new(&e))
    }
    pub fn witness(&mut self) -> Result<u32, JsError> {
        self.witness_inner().map_err(|e| JsError::new(&e))
    }
    pub fn set_expected_end(&mut self, orchard_tree: &[u8], ironwood_tree: &[u8]) -> Result<(), JsError> {
        self.set_expected_end_inner(orchard_tree, ironwood_tree).map_err(|e| JsError::new(&e))
    }
    /// True when both trees start empty, which a range from the middle of the chain never does.
    pub fn starts_empty(&self) -> bool {
        self.start_is_empty()
    }
    /// Skip transactions with more actions than this, as ChainSafe did during the spam period. Off by default.
    pub fn set_filter(&mut self, limit: u32) -> Result<(), JsError> {
        self.set_filter_inner(limit).map_err(|e| JsError::new(&e))
    }
    /// Scan with a published viewing key instead of the synthetic one. Returns its network.
    pub fn set_ufvk(&mut self, ufvk: &str) -> Result<String, JsError> {
        self.set_ufvk_inner(ufvk).map_err(|e| JsError::new(&e))
    }
    /// Everything the result JSON needs from the scan, as one JSON string.
    pub fn summary(&self) -> String {
        let mut sizes = self.message_sizes.clone();
        sizes.sort_unstable();
        let n = sizes.len();
        let median = if n == 0 { 0.0 } else if n % 2 == 1 { sizes[n / 2] as f64 } else { (sizes[n / 2 - 1] + sizes[n / 2]) as f64 / 2.0 };
        let compact = format!(
            "\"compact_bytes\":{},\"compact_bytes_by_block\":{{\"min\":{},\"median\":{},\"max\":{}}}",
            sizes.iter().sum::<u64>(),
            sizes.first().copied().unwrap_or(0),
            median,
            sizes.last().copied().unwrap_or(0)
        );
        let root = |b: Option<[u8; 32]>| b.map_or("null".to_string(), |b| format!("\"{}\"", b.iter().map(|x| format!("{x:02x}")).collect::<String>()));
        let end = |p: usize| root(self.root_bytes(p).ok());
        let tree_roots = format!(
            "\"tree_roots\":{{\"orchard\":{{\"start\":{},\"end\":{}}},\"ironwood\":{{\"start\":{},\"end\":{}}}}}",
            root(Some(self.start_root_bytes(0))),
            end(0),
            root(Some(self.start_root_bytes(1))),
            end(1)
        );
        let hex = self.corpus_sha256.map(|d| d.iter().map(|b| format!("{b:02x}")).collect::<String>());
        format!(
            "{{\"blocks\":{},\"start_height\":{},\"actions_by_pool\":{{\"orchard\":{},\"ironwood\":{}}},\"found\":{{\"orchard_external\":{},\"orchard_internal\":{},\"ironwood_external\":{},\"ironwood_internal\":{}}},\"ivk_count\":2,\"batch_size\":{{\"orchard\":{},\"ironwood\":{}}},\"batches_made\":{{\"orchard\":{},\"ironwood\":{}}},\"filter\":{},\"corpus_sha256\":{},{},\"key_sha256\":{},\"received_zat\":{},\"spent_in_range_zat\":{},{}}}",
            self.block_sizes.len(),
            self.start_height,
            self.action_counts[0],
            self.action_counts[1],
            self.found[0][0],
            self.found[0][1],
            self.found[1][0],
            self.found[1][1],
            self.batches[0],
            self.batches[1],
            self.chunks[0],
            self.chunks[1],
            self.filter.map_or("null".to_string(), |f| f.to_string()),
            hex.map_or("null".to_string(), |h| format!("\"{h}\"")),
            compact,
            self.key_sha256.as_ref().map_or("null".to_string(), |h| format!("\"{h}\"")),
            self.received_zat,
            self.spent_zat,
            tree_roots,
        )
    }
}
