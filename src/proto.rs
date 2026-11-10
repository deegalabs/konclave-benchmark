// SPDX-License-Identifier: MIT OR Apache-2.0
//! The fields of lightwalletd's CompactBlock this harness reads. Unknown fields are ignored by prost, so a real
//! message decodes. tests/wire.rs checks these tags against zcash_client_backend 0.25.0, the crate that defines them.

#[derive(Clone, PartialEq, prost::Message)]
pub struct ChainMetadata {
    #[prost(uint32, tag = "2")]
    pub orchard_commitment_tree_size: u32,
    #[prost(uint32, tag = "3")]
    pub ironwood_commitment_tree_size: u32,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct CompactBlock {
    #[prost(uint64, tag = "2")]
    pub height: u64,
    #[prost(bytes = "vec", tag = "3")]
    pub hash: Vec<u8>,
    #[prost(bytes = "vec", tag = "4")]
    pub prev_hash: Vec<u8>,
    #[prost(message, repeated, tag = "7")]
    pub vtx: Vec<CompactTx>,
    #[prost(message, optional, tag = "8")]
    pub chain_metadata: Option<ChainMetadata>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct CompactTx {
    #[prost(uint64, tag = "1")]
    pub index: u64,
    #[prost(bytes = "vec", tag = "2")]
    pub txid: Vec<u8>,
    #[prost(message, repeated, tag = "6")]
    pub actions: Vec<CompactOrchardAction>,
    #[prost(message, repeated, tag = "9")]
    pub ironwood_actions: Vec<CompactOrchardAction>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub struct CompactOrchardAction {
    #[prost(bytes = "vec", tag = "1")]
    pub nullifier: Vec<u8>,
    #[prost(bytes = "vec", tag = "2")]
    pub cmx: Vec<u8>,
    #[prost(bytes = "vec", tag = "3")]
    pub ephemeral_key: Vec<u8>,
    #[prost(bytes = "vec", tag = "4")]
    pub ciphertext: Vec<u8>,
}
