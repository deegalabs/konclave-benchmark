// SPDX-License-Identifier: MIT OR Apache-2.0
//! A deterministic synthetic corpus: real notes from the orchard builder in real CompactBlock messages, with notes for
//! our key planted in both pools under both key scopes. It measures the cost of looking, and tests the harness. It is
//! not a chain: its density is whatever these parameters say. Native only.
use crate::{corpus, proto, prove::KEY_SEED};
use incrementalmerkletree::frontier::Frontier;
use orchard::{
    builder::{Builder, BundleType},
    bundle::BundleVersion,
    keys::{FullViewingKey, Scope, SpendingKey},
    tree::MerkleHashOrchard,
    value::NoteValue,
    Anchor,
};
use prost::Message;
use rand::{rngs::StdRng, Rng, RngExt, SeedableRng};

pub const PLANTED_ZAT: u64 = 1000;

#[derive(Clone, Copy)]
pub struct Params {
    pub blocks: u32,
    /// Blocks with this many transactions per pool; every 4th block is empty.
    pub txs_per_block: u32,
    pub actions_per_tx: u32,
    /// One note for our key in every this many transactions.
    pub ours_every: u32,
    /// Adds a transaction of this many actions, with a note of ours, in the second block.
    pub big_tx: Option<u32>,
    /// Blocks of the same chain to leave out of the corpus, as if already scanned: the corpus starts from their tree.
    pub skip_blocks: u32,
    pub start_height: u64,
}

impl Default for Params {
    fn default() -> Self {
        Params { blocks: 40, txs_per_block: 2, actions_per_tx: 4, ours_every: 5, big_tx: None, skip_blocks: 0, start_height: 3_000_000 }
    }
}

fn key(bytes: [u8; 32]) -> Option<FullViewingKey> {
    Option::<SpendingKey>::from(SpendingKey::from_bytes(bytes)).map(|sk| FullViewingKey::from(&sk))
}

fn bundle_actions(
    bv: BundleVersion,
    n: u32,
    plant: Option<(&FullViewingKey, Scope)>,
    other: &FullViewingKey,
    rng: &mut StdRng,
) -> Vec<proto::CompactOrchardAction> {
    let mut b = Builder::new(BundleType::DEFAULT, bv, bv.default_flags(), Anchor::empty_tree()).unwrap();
    for i in 0..n {
        let (fvk, scope) = match plant {
            Some((f, s)) if i == 0 => (f, s),
            _ => (other, Scope::External),
        };
        let value = if plant.is_some() && i == 0 { PLANTED_ZAT } else { 0 };
        b.add_change_output(fvk.clone(), None, fvk.address_at(0u32, scope), NoteValue::from_raw(value), [0u8; 512]).unwrap();
    }
    let (bundle, _) = b.build::<i64>(&mut *rng).unwrap().unwrap();
    assert_eq!(bundle.actions().len(), n as usize, "one action per change output");
    bundle
        .actions()
        .iter()
        .map(|a| proto::CompactOrchardAction {
            nullifier: a.nullifier().to_bytes().to_vec(),
            cmx: a.cmx().to_bytes().to_vec(),
            ephemeral_key: a.encrypted_note().epk_bytes.to_vec(),
            ciphertext: AsRef::<[u8]>::as_ref(&a.encrypted_note().enc_ciphertext)[..52].to_vec(),
        })
        .collect()
}

/// The legacy form of a tree state, as GetTreeState serves it, for a corpus that starts inside a chain.
fn legacy(f: &Frontier<MerkleHashOrchard, 32>) -> Vec<u8> {
    if f.value().is_none() {
        return Vec::new();
    }
    let t = incrementalmerkletree::frontier::CommitmentTree::<MerkleHashOrchard, 32>::from_frontier(f);
    let mut out = Vec::new();
    let opt = |h: Option<&MerkleHashOrchard>, out: &mut Vec<u8>| match h {
        Some(h) => {
            out.push(1);
            out.extend_from_slice(&h.to_bytes());
        }
        None => out.push(0),
    };
    opt(t.left().as_ref(), &mut out);
    opt(t.right().as_ref(), &mut out);
    assert!(t.parents().len() < 0xfd);
    out.push(t.parents().len() as u8);
    for p in t.parents() {
        opt(p.as_ref(), &mut out);
    }
    out
}

pub fn generate(p: Params) -> Vec<u8> {
    generate_with_end(p).0
}

/// The corpus, and the tree states at its end in the form GetTreeState serves them.
pub fn generate_with_end(p: Params) -> (Vec<u8>, [Vec<u8>; 2]) {
    let ours = key(KEY_SEED).unwrap();
    let mut rng = StdRng::seed_from_u64(0x5ca7_0002);
    let mut other_seed = [0u8; 32];
    let other = loop {
        rng.fill_bytes(&mut other_seed);
        if let Some(k) = key(other_seed) {
            break k;
        }
    };
    let _ = rng.random_range(0..2u32);
    let versions = [BundleVersion::orchard_v2(), BundleVersion::ironwood_v3()];
    let mut frontiers = [Frontier::<MerkleHashOrchard, 32>::empty(), Frontier::empty()];
    let mut start_trees = [Vec::new(), Vec::new()];
    let mut counts = [0u32; 2];
    let mut expected = [0u32; 4];
    let mut tx_counter = [0u32; 2];
    let mut messages = Vec::new();
    for bi in 0..(p.skip_blocks + p.blocks) {
        let in_range = bi >= p.skip_blocks;
        if bi == p.skip_blocks {
            start_trees = [legacy(&frontiers[0]), legacy(&frontiers[1])];
        }
        let mut vtx = Vec::new();
        if bi % 4 != 3 {
            for t in 0..p.txs_per_block {
                let mut tx = proto::CompactTx { index: t as u64, txid: vec![0; 32], ..Default::default() };
                for pool in 0..2 {
                    tx_counter[pool] += 1;
                    let due = tx_counter[pool] % p.ours_every == 0;
                    // Alternates per pool, so both pools get both scopes.
                    let scope = if (tx_counter[pool] / p.ours_every) % 2 == 0 { Scope::External } else { Scope::Internal };
                    let plant = due.then_some((&ours, scope));
                    let list = bundle_actions(versions[pool], p.actions_per_tx, plant, &other, &mut rng);
                    if plant.is_some() && in_range {
                        expected[pool * 2 + (scope == Scope::Internal) as usize] += 1;
                    }
                    if pool == 0 { tx.actions = list } else { tx.ironwood_actions = list }
                }
                vtx.push(tx);
            }
        }
        if bi == p.skip_blocks + 1 {
            if let Some(n) = p.big_tx {
                let list = bundle_actions(versions[1], n, Some((&ours, Scope::External)), &other, &mut rng);
                expected[2] += 1;
                vtx.push(proto::CompactTx { index: 99, txid: vec![1; 32], ironwood_actions: list, ..Default::default() });
            }
        }
        for tx in &vtx {
            for (pool, list) in [&tx.actions, &tx.ironwood_actions].into_iter().enumerate() {
                for a in list {
                    let cmx: [u8; 32] = a.cmx.as_slice().try_into().unwrap();
                    let cmx = orchard::note::ExtractedNoteCommitment::from_bytes(&cmx).unwrap();
                    frontiers[pool].append(MerkleHashOrchard::from_cmx(&cmx));
                    if in_range {
                        counts[pool] += 1;
                    }
                }
            }
        }
        if in_range {
            let block = proto::CompactBlock {
                height: p.start_height + (bi - p.skip_blocks) as u64,
                hash: vec![bi as u8; 32],
                prev_hash: vec![bi.wrapping_sub(1) as u8; 32],
                vtx,
                chain_metadata: Some(proto::ChainMetadata {
                    orchard_commitment_tree_size: frontiers[0].tree_size() as u32,
                    ironwood_commitment_tree_size: frontiers[1].tree_size() as u32,
                }),
            };
            messages.push(block.encode_to_vec());
        }
    }
    let h = corpus::Header {
        start_height: p.start_height,
        blocks: p.blocks,
        orchard_actions: counts[0],
        ironwood_actions: counts[1],
        roots: Some((frontiers[0].root().to_bytes(), frontiers[1].root().to_bytes())),
        expected,
        orchard_tree: start_trees[0].clone(),
        ironwood_tree: start_trees[1].clone(),
    };
    (corpus::write(&h, &messages), [legacy(&frontiers[0]), legacy(&frontiers[1])])
}
