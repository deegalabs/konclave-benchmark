// SPDX-License-Identifier: MIT OR Apache-2.0
//! Our message tags and tree-state parser against the crates that define them.
use incrementalmerkletree::frontier::CommitmentTree;
use konclave_benchmark::{proto, tree};
use orchard::tree::MerkleHashOrchard;
use prost::Message;
use zcash_client_backend::proto::compact_formats as theirs;

#[test]
fn a_message_from_the_backend_decodes_here_field_by_field() {
    let action = theirs::CompactOrchardAction {
        nullifier: vec![1; 32],
        cmx: vec![2; 32],
        ephemeral_key: vec![3; 32],
        ciphertext: vec![4; 52],
    };
    let block = theirs::CompactBlock {
        height: 7,
        hash: vec![9; 32],
        prev_hash: vec![8; 32],
        vtx: vec![theirs::CompactTx {
            index: 2,
            txid: vec![5; 32],
            actions: vec![action.clone()],
            ironwood_actions: vec![action.clone(), action],
            ..Default::default()
        }],
        chain_metadata: Some(theirs::ChainMetadata {
            sapling_commitment_tree_size: 100,
            orchard_commitment_tree_size: 11,
            ironwood_commitment_tree_size: 22,
        }),
        ..Default::default()
    };
    let ours = proto::CompactBlock::decode(block.encode_to_vec().as_slice()).unwrap();
    assert_eq!(ours.height, 7);
    assert_eq!(ours.hash, vec![9; 32]);
    assert_eq!(ours.prev_hash, vec![8; 32]);
    let m = ours.chain_metadata.unwrap();
    assert_eq!(
        (
            m.orchard_commitment_tree_size,
            m.ironwood_commitment_tree_size
        ),
        (11, 22)
    );
    let t = &ours.vtx[0];
    assert_eq!((t.index, t.txid.clone()), (2, vec![5; 32]));
    assert_eq!((t.actions.len(), t.ironwood_actions.len()), (1, 2));
    let a = &t.ironwood_actions[1];
    assert_eq!(
        (
            a.nullifier[0],
            a.cmx[0],
            a.ephemeral_key[0],
            a.ciphertext[0]
        ),
        (1, 2, 3, 4)
    );
}

#[test]
fn a_tree_state_written_by_zcash_primitives_parses_to_the_same_root() {
    use incrementalmerkletree::Hashable;
    for n in [0u64, 1, 2, 3, 5, 8, 300] {
        let mut t = CommitmentTree::<MerkleHashOrchard, 32>::empty();
        let mut f = incrementalmerkletree::frontier::Frontier::<MerkleHashOrchard, 32>::empty();
        let mut leaf = MerkleHashOrchard::empty_leaf();
        for _ in 0..n {
            leaf = MerkleHashOrchard::combine(0.into(), &leaf, &leaf);
            t.append(leaf).unwrap();
            f.append(leaf);
        }
        let mut bytes = Vec::new();
        zcash_primitives::merkle_tree::write_commitment_tree(&t, &mut bytes).unwrap();
        let parsed = tree::parse_legacy(&bytes).unwrap();
        assert_eq!(parsed.root(), f.root(), "n = {n}");
        assert_eq!(parsed.tree_size(), n, "n = {n}");
    }
}

#[test]
fn a_damaged_tree_state_is_refused() {
    assert!(tree::parse_legacy(&[7]).is_err());
    assert!(tree::parse_legacy(&[1, 2, 3]).is_err());
    assert!(tree::parse_legacy(&[0, 0, 0, 9]).is_err());
}

#[test]
fn a_parent_count_that_needs_a_longer_length_is_refused() {
    assert!(tree::parse_legacy(&[0, 0, 0xfd, 1, 0]).is_err());
}
