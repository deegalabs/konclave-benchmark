// SPDX-License-Identifier: MIT OR Apache-2.0
//! A saved range of compact blocks, so a number can be re-run without a server. The blocks stay in lightwalletd's own
//! protobuf form, so a synthetic corpus and a real one go through the same decoder.
//!
//! Layout: "KBCP", u32 version, sha256 of everything after this field, then
//! u64 start height, u32 blocks, u32 orchard actions, u32 ironwood actions, u8 has roots, 32 orchard root,
//! 32 ironwood root, four u32 expected notes (orchard external, orchard internal, ironwood external, ironwood
//! internal; u32::MAX means unknown), u32 + bytes for each pool's tree state before the range (empty means an empty
//! tree), then for each block u32 + the CompactBlock message.
use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 4] = b"KBCP";
pub const VERSION: u32 = 1;
pub const UNKNOWN: u32 = u32::MAX;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub start_height: u64,
    pub blocks: u32,
    pub orchard_actions: u32,
    pub ironwood_actions: u32,
    pub roots: Option<([u8; 32], [u8; 32])>,
    pub expected: [u32; 4],
    pub orchard_tree: Vec<u8>,
    pub ironwood_tree: Vec<u8>,
}

pub fn write(h: &Header, blocks: &[Vec<u8>]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&h.start_height.to_le_bytes());
    b.extend_from_slice(&h.blocks.to_le_bytes());
    b.extend_from_slice(&h.orchard_actions.to_le_bytes());
    b.extend_from_slice(&h.ironwood_actions.to_le_bytes());
    let (o, i) = h.roots.unwrap_or(([0; 32], [0; 32]));
    b.push(h.roots.is_some() as u8);
    b.extend_from_slice(&o);
    b.extend_from_slice(&i);
    for e in h.expected {
        b.extend_from_slice(&e.to_le_bytes());
    }
    for t in [&h.orchard_tree, &h.ironwood_tree] {
        b.extend_from_slice(&(t.len() as u32).to_le_bytes());
        b.extend_from_slice(t);
    }
    for m in blocks {
        b.extend_from_slice(&(m.len() as u32).to_le_bytes());
        b.extend_from_slice(m);
    }
    let mut out = Vec::with_capacity(40 + b.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&Sha256::digest(&b));
    out.extend_from_slice(&b);
    out
}

/// Recomputes the hash after an edit; only tests and the generator use it.
pub fn reseal(file: &mut [u8]) {
    let d = Sha256::digest(&file[40..]);
    file[8..40].copy_from_slice(&d);
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.0.len() < n {
            return Err("corpus ends early".into());
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn arr32(&mut self) -> Result<[u8; 32], String> {
        Ok(self.take(32)?.try_into().unwrap())
    }
}

/// The header, the framed messages and the digest of a parsed corpus.
pub type Parsed<'a> = (Header, Vec<&'a [u8]>, [u8; 32]);

/// Refuses a corpus whose hash does not match, or whose framing does not match its own header.
pub fn parse(file: &[u8]) -> Result<Parsed<'_>, String> {
    if file.len() < 40 || &file[0..4] != MAGIC {
        return Err("not a corpus file".into());
    }
    if file[4..8] != VERSION.to_le_bytes() {
        return Err("unknown corpus version".into());
    }
    let digest: [u8; 32] = Sha256::digest(&file[40..]).into();
    if digest != file[8..40] {
        return Err("corpus hash does not match its contents".into());
    }
    let mut r = Reader(&file[40..]);
    let start_height = r.u64()?;
    let blocks = r.u32()?;
    let orchard_actions = r.u32()?;
    let ironwood_actions = r.u32()?;
    let has_roots = r.take(1)?[0];
    let (o, i) = (r.arr32()?, r.arr32()?);
    let expected = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    let n = r.u32()? as usize;
    let orchard_tree = r.take(n)?.to_vec();
    let n = r.u32()? as usize;
    let ironwood_tree = r.take(n)?.to_vec();
    let mut msgs = Vec::with_capacity(blocks as usize);
    for _ in 0..blocks {
        let n = r.u32()? as usize;
        msgs.push(r.take(n)?);
    }
    if !r.0.is_empty() {
        return Err("corpus has more blocks than its header says".into());
    }
    let roots = (has_roots == 1).then_some((o, i));
    let h = Header {
        start_height,
        blocks,
        orchard_actions,
        ironwood_actions,
        roots,
        expected,
        orchard_tree,
        ironwood_tree,
    };
    Ok((h, msgs, digest))
}
