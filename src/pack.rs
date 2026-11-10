// SPDX-License-Identifier: MIT OR Apache-2.0
//! Packs blocks a server sent, plus its tree states, into a corpus. Roots come from the end tree states, the counts from
//! the blocks, and which notes a key should find is unknown, so nothing here depends on a key. Native only.
use crate::{corpus, proto, tree};
use prost::Message;

pub fn pack(
    start_height: u64,
    messages: &[Vec<u8>],
    start: [&[u8]; 2],
    end: [&[u8]; 2],
) -> Result<Vec<u8>, String> {
    let (mut orchard_actions, mut ironwood_actions) = (0u32, 0u32);
    for (i, m) in messages.iter().enumerate() {
        let b = proto::CompactBlock::decode(m.as_slice()).map_err(|e| format!("block {i}: {e}"))?;
        if b.height != start_height + i as u64 {
            return Err(format!(
                "expected block {}, got {}",
                start_height + i as u64,
                b.height
            ));
        }
        for t in b.vtx {
            orchard_actions += t.actions.len() as u32;
            ironwood_actions += t.ironwood_actions.len() as u32;
        }
    }
    let root = |b: &[u8]| tree::parse_legacy(b).map(|f| f.root().to_bytes());
    let h = corpus::Header {
        start_height,
        blocks: messages.len() as u32,
        orchard_actions,
        ironwood_actions,
        roots: Some((root(end[0])?, root(end[1])?)),
        expected: [corpus::UNKNOWN; 4],
        orchard_tree: start[0].to_vec(),
        ironwood_tree: start[1].to_vec(),
    };
    Ok(corpus::write(&h, messages))
}
