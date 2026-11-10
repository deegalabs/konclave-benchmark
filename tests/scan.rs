// SPDX-License-Identifier: MIT OR Apache-2.0
use konclave_benchmark::{
    corpus,
    scan::Scan,
    synth::{self, Params},
};

fn all_stages(file: &[u8]) -> Result<Scan, String> {
    let mut s = Scan::from_corpus(file)?;
    s.decode_inner()?;
    s.decrypt_inner()?;
    s.tree_inner()?;
    s.witness_inner()?;
    Ok(s)
}

fn small() -> Vec<u8> {
    synth::generate(Params { blocks: 8, ..Default::default() })
}

#[test]
fn a_changed_byte_is_refused() {
    let mut f = small();
    let n = f.len();
    f[n - 3] ^= 1;
    assert!(Scan::from_corpus(&f).err().unwrap().contains("hash"));
}

#[test]
fn a_truncated_corpus_or_a_wrong_block_count_is_refused() {
    let f = small();
    let mut t = f[..f.len() - 10].to_vec();
    corpus::reseal(&mut t);
    assert!(Scan::from_corpus(&t).is_err());
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let fewer: Vec<Vec<u8>> = msgs[1..].iter().map(|m| m.to_vec()).collect();
    let bad = corpus::write(&corpus::Header { blocks: h.blocks - 1, ..h }, &fewer);
    let mut s = Scan::from_corpus(&bad).unwrap();
    assert!(s.decode_inner().is_err(), "the first height no longer matches");
}

#[test]
fn a_block_missing_from_the_middle_is_refused() {
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let mut m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    m.remove(3);
    let bad = corpus::write(&corpus::Header { blocks: h.blocks - 1, ..h }, &m);
    let mut s = Scan::from_corpus(&bad).unwrap();
    assert!(s.decode_inner().err().unwrap().contains("expected block"));
}

// The mutation the first harness could not catch, a commitment that is not the real one
#[test]
fn the_tree_is_of_the_real_commitments() {
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    use konclave_benchmark::proto::CompactBlock;
    use prost::Message;
    let mut m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let mut b = CompactBlock::decode(m[0].as_slice()).unwrap();
    let last = b.vtx[0].ironwood_actions.len() - 1;
    let a = b.vtx[0].ironwood_actions[0].cmx.clone();
    b.vtx[0].ironwood_actions[last].cmx = a;
    m[0] = b.encode_to_vec();
    let bad = corpus::write(&h, &m);
    let mut s = Scan::from_corpus(&bad).unwrap();
    s.decode_inner().unwrap();
    s.decrypt_inner().ok();
    if s.tree_inner().is_ok() {
        panic!("a changed commitment must not reach the corpus root");
    }
}

// From the middle of a chain
#[test]
fn a_range_that_starts_inside_a_chain_reaches_the_same_root_as_the_whole_chain() {
    let whole = synth::generate(Params { blocks: 12, ..Default::default() });
    let tail = synth::generate(Params { blocks: 7, skip_blocks: 5, ..Default::default() });
    let a = all_stages(&whole).unwrap();
    let b = all_stages(&tail).unwrap();
    assert_eq!(a.root_bytes(0).unwrap(), b.root_bytes(0).unwrap());
    assert_eq!(a.root_bytes(1).unwrap(), b.root_bytes(1).unwrap());
}

// Nothing carries over
#[test]
fn a_scan_is_single_use_and_stages_run_in_order() {
    let f = small();
    let mut s = Scan::from_corpus(&f).unwrap();
    assert!(s.decrypt_inner().is_err());
    s.decode_inner().unwrap();
    assert!(s.decode_inner().is_err());
    s.decrypt_inner().unwrap();
    s.tree_inner().unwrap();
    assert!(s.tree_inner().is_err());
}

#[test]
fn notes_are_found_in_both_pools_under_both_keys() {
    let s = all_stages(&small()).unwrap();
    let [o, i] = s.found_by_pool_and_key();
    assert!(o[0] > 0 && o[1] > 0, "orchard {o:?}");
    assert!(i[0] > 0 && i[1] > 0, "ironwood {i:?}");
}

#[test]
fn a_note_in_a_big_transaction_is_found_by_default_and_lost_with_a_filter() {
    let f = synth::generate(Params { blocks: 3, big_tx: Some(60), ..Default::default() });
    let plain = all_stages(&f).unwrap();
    let (h, _, _) = corpus::parse(&f).unwrap();
    assert_eq!(plain.found_by_pool_and_key()[1][0], h.expected[2]);
    let mut filtered = Scan::from_corpus(&f).unwrap();
    filtered.set_filter_inner(50).unwrap();
    filtered.decode_inner().unwrap();
    filtered.decrypt_inner().unwrap();
    assert_eq!(filtered.found_by_pool_and_key()[1][0], h.expected[2] - 1);
    // The filter skips decryption, never the tree: the root stays right.
    filtered.tree_inner().unwrap();
}

#[test]
fn an_unrelated_viewing_key_finds_nothing_and_the_tree_still_holds() {
    use zcash_address::unified::{self, Encoding, Revision};
    use zcash_protocol::consensus::NetworkType;
    let sk = orchard::keys::SpendingKey::from_bytes([42; 32]).unwrap();
    let fvk = orchard::keys::FullViewingKey::from(&sk);
    let ufvk = unified::Ufvk::try_from_items(Revision::R0, vec![unified::Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))]).unwrap().encode(&NetworkType::Test);
    let f = small();
    let mut s = Scan::from_corpus(&f).unwrap();
    assert!(s.set_ufvk_inner("not-a-key").is_err());
    assert_eq!(s.set_ufvk_inner(&ufvk).unwrap(), "Test");
    s.decode_inner().unwrap();
    // The corpus says which notes the synthetic key holds; another key must disagree, and it says so.
    assert!(s.decrypt_inner().err().unwrap().contains("expected notes"));
}

#[test]
fn a_foreign_key_on_a_range_with_no_expectation_finds_zero() {
    use zcash_address::unified::{self, Encoding, Revision};
    use zcash_protocol::consensus::NetworkType;
    let sk = orchard::keys::SpendingKey::from_bytes([42; 32]).unwrap();
    let fvk = orchard::keys::FullViewingKey::from(&sk);
    let ufvk = unified::Ufvk::try_from_items(Revision::R0, vec![unified::Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))]).unwrap().encode(&NetworkType::Test);
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let open = corpus::write(&corpus::Header { expected: [corpus::UNKNOWN; 4], ..h }, &m);
    let mut s = Scan::from_corpus(&open).unwrap();
    s.set_ufvk_inner(&ufvk).unwrap();
    s.decode_inner().unwrap();
    assert_eq!(s.decrypt_inner().unwrap(), 0);
    s.tree_inner().unwrap();
    assert_eq!(s.witness_inner().unwrap(), 0);
    assert!(s.summary().contains("\"ivk_count\":2"));
}

#[test]
fn the_balance_counts_what_was_received_and_a_spend_in_the_range() {
    use konclave_benchmark::proto::CompactBlock;
    use orchard::keys::{FullViewingKey, SpendingKey};
    use prost::Message;
    let f = small();
    let plain = all_stages(&f).unwrap();
    let [o, i] = plain.found_by_pool_and_key();
    let notes = (o[0] + o[1] + i[0] + i[1]) as u64;
    assert_eq!(plain.received_and_spent(), (notes * synth::PLANTED_ZAT, 0));

    // Find one of our notes, then put its nullifier on a later action that is not ours: that is a spend.
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let mut m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let fvk = FullViewingKey::from(&SpendingKey::from_bytes([7; 32]).unwrap());
    let ivk = orchard::keys::PreparedIncomingViewingKey::new(&fvk.to_ivk(orchard::keys::Scope::External));
    let mut nf = None;
    'outer: for bytes in &m {
        for tx in CompactBlock::decode(bytes.as_slice()).unwrap().vtx {
            for a in &tx.ironwood_actions {
                let ca = orchard::note_encryption::CompactAction::from_parts(
                    orchard::note::Nullifier::from_bytes(a.nullifier.as_slice().try_into().unwrap()).unwrap(),
                    orchard::note::ExtractedNoteCommitment::from_bytes(a.cmx.as_slice().try_into().unwrap()).unwrap(),
                    zcash_note_encryption::EphemeralKeyBytes(a.ephemeral_key.as_slice().try_into().unwrap()),
                    a.ciphertext.as_slice().try_into().unwrap(),
                );
                let d = orchard::note_encryption::IronwoodDomain::for_compact_action(&ca);
                if let Some((note, _)) = zcash_note_encryption::try_compact_note_decryption(&d, &ivk, &ca) {
                    nf = Some(note.nullifier(&fvk).to_bytes().to_vec());
                    break 'outer;
                }
            }
        }
    }
    let nf = nf.expect("a note of ours");
    let last = m.len() - 2; // the last block with transactions is not the final, empty pattern block
    let mut b = CompactBlock::decode(m[last].as_slice()).unwrap();
    let t = b.vtx.iter_mut().find(|t| !t.actions.is_empty()).expect("a transaction");
    t.actions[0].nullifier = nf;
    m[last] = b.encode_to_vec();
    let open = corpus::write(&corpus::Header { expected: [corpus::UNKNOWN; 4], ..h }, &m);
    let s = all_stages(&open).unwrap();
    assert_eq!(s.received_and_spent().1, synth::PLANTED_ZAT);
}

#[test]
fn a_block_that_does_not_follow_the_one_before_it_is_refused() {
    use konclave_benchmark::proto::CompactBlock;
    use prost::Message;
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let mut m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let mut b = CompactBlock::decode(m[4].as_slice()).unwrap();
    b.prev_hash = vec![0xee; 32];
    m[4] = b.encode_to_vec();
    let mut s = Scan::from_corpus(&corpus::write(&h, &m)).unwrap();
    assert!(s.decode_inner().err().unwrap().contains("does not follow"));
}

fn with_block(f: &[u8], i: usize, edit: impl Fn(&mut konclave_benchmark::proto::CompactBlock)) -> Vec<u8> {
    use konclave_benchmark::proto::CompactBlock;
    use prost::Message;
    let (h, msgs, _) = corpus::parse(f).unwrap();
    let mut m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let mut b = CompactBlock::decode(m[i].as_slice()).unwrap();
    edit(&mut b);
    m[i] = b.encode_to_vec();
    corpus::write(&h, &m)
}

// The root of each pool is checked, not only one
#[test]
fn a_changed_orchard_commitment_is_caught_too() {
    let bad = with_block(&small(), 0, |b| {
        let c = b.vtx[0].actions[0].cmx.clone();
        let last = b.vtx[0].actions.len() - 1;
        b.vtx[0].actions[last].cmx = c;
    });
    let mut s = Scan::from_corpus(&bad).unwrap();
    s.decode_inner().unwrap();
    s.decrypt_inner().ok();
    if s.tree_inner().is_ok() {
        panic!("a changed Orchard commitment must not reach the corpus root");
    }
}

#[test]
fn a_block_that_declares_another_tree_size_is_refused() {
    for pool in 0..2 {
        let bad = with_block(&small(), 2, |b| {
            let c = b.chain_metadata.as_mut().unwrap();
            if pool == 0 { c.orchard_commitment_tree_size += 1 } else { c.ironwood_commitment_tree_size += 1 }
        });
        let mut s = Scan::from_corpus(&bad).unwrap();
        assert!(s.decode_inner().err().unwrap().contains("tree size"), "pool {pool}");
    }
}

#[test]
fn a_header_with_other_action_counts_is_refused() {
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    for bad in [corpus::Header { orchard_actions: h.orchard_actions + 1, ..h.clone() }, corpus::Header { ironwood_actions: h.ironwood_actions + 1, ..h.clone() }] {
        let mut s = Scan::from_corpus(&corpus::write(&bad, &m)).unwrap();
        assert!(s.decode_inner().err().unwrap().contains("action counts"));
    }
}

// The summary's counts per pool are each pool's, by a count made here
#[test]
fn the_summary_counts_each_pool_on_its_own() {
    use konclave_benchmark::proto::CompactBlock;
    use prost::Message;
    // A corpus with Ironwood actions only in one extra transaction, so the two pools differ.
    let f = synth::generate(Params { blocks: 3, big_tx: Some(60), ..Default::default() });
    let (_, msgs, _) = corpus::parse(&f).unwrap();
    let (mut o, mut i) = (0, 0);
    for m in msgs {
        for t in CompactBlock::decode(m).unwrap().vtx {
            o += t.actions.len();
            i += t.ironwood_actions.len();
        }
    }
    assert_ne!(o, i);
    let s = all_stages(&f).unwrap().summary();
    assert!(s.contains(&format!("\"orchard\":{o},\"ironwood\":{i}")), "{s}");
}

#[test]
fn more_blocks_than_the_header_says_are_refused() {
    let f = small();
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let bad = corpus::write(&corpus::Header { blocks: h.blocks - 1, ..h }, &m);
    assert!(Scan::from_corpus(&bad).err().unwrap().contains("more blocks"));
}

// W-a
#[test]
fn a_witness_is_made_for_every_note_found() {
    let f = small();
    let mut s = Scan::from_corpus(&f).unwrap();
    s.decode_inner().unwrap();
    let notes = s.decrypt_inner().unwrap();
    s.tree_inner().unwrap();
    assert!(notes > 0);
    assert_eq!(s.witness_inner().unwrap(), notes);
}

// A range packed from what a server sent is scanned like the corpus it came from, and a wrong end state is caught
#[test]
fn a_packed_range_scans_to_the_same_root() {
    let (f, end) = synth::generate_with_end(Params { blocks: 6, ..Default::default() });
    let (h, msgs, _) = corpus::parse(&f).unwrap();
    let m: Vec<Vec<u8>> = msgs.iter().map(|x| x.to_vec()).collect();
    let packed = konclave_benchmark::pack::pack(h.start_height, &m, [&[], &[]], [&end[0], &end[1]]).unwrap();
    let a = all_stages(&f).unwrap();
    let b = all_stages(&packed).unwrap();
    assert_eq!(a.root_bytes(0).unwrap(), b.root_bytes(0).unwrap());
    assert_eq!(a.root_bytes(1).unwrap(), b.root_bytes(1).unwrap());
    let wrong = konclave_benchmark::pack::pack(h.start_height, &m, [&[], &[]], [&end[1], &end[0]]).unwrap();
    assert!(all_stages(&wrong).err().unwrap().contains("root"));
    let gap = konclave_benchmark::pack::pack(h.start_height + 1, &m, [&[], &[]], [&end[0], &end[1]]);
    assert!(gap.is_err());
}

#[test]
fn a_small_pool_still_splits_into_batches_for_every_thread() {
    use konclave_benchmark::scan::batch_for;
    assert_eq!(batch_for(100_000, 4), 1024);
    assert_eq!(batch_for(1_000, 4), 64);
    assert!(1_000usize.div_ceil(batch_for(1_000, 4)) >= 4 * 4 - 1);
    assert_eq!(batch_for(10, 1), 64);
    assert_eq!(batch_for(5_000, 0), 1024);
}

// The decrypt call uses the batch rule, not the ceiling: a small corpus reports a small batch.
#[test]
fn a_small_corpus_reports_the_batch_it_used() {
    // About 900 actions per pool: under the 1024 ceiling, over one minimum batch.
    let s = all_stages(&synth::generate(Params { blocks: 40, actions_per_tx: 16, ..Default::default() })).unwrap();
    assert!(!s.summary().contains("\"batch_size\":{\"orchard\":1024"), "{}", s.summary());
    // More than one batch per pool on this corpus: decrypting it in one ceiling-sized batch would show 1.
    let made = s.summary();
    let n = |pool: &str| -> usize {
        let i = made.find("\"batches_made\":").unwrap();
        let rest = &made[i..];
        let j = rest.find(&format!("\"{pool}\":")).unwrap() + pool.len() + 3;
        rest[j..].split([',', '}']).next().unwrap().parse().unwrap()
    };
    assert!(n("orchard") > 1 && n("ironwood") > 1, "{made}");
}

// The result carries no part of a typed viewing key: a hash of it, so rows can be told apart, and nothing else.
#[test]
fn the_summary_holds_a_hash_of_the_key_and_no_part_of_it() {
    use sha2::{Digest, Sha256};
    use zcash_address::unified::{self, Encoding, Revision};
    use zcash_protocol::consensus::NetworkType;
    let sk = orchard::keys::SpendingKey::from_bytes([42; 32]).unwrap();
    let fvk = orchard::keys::FullViewingKey::from(&sk);
    let ufvk = unified::Ufvk::try_from_items(Revision::R0, vec![unified::Uitem::Data(unified::Fvk::Orchard(fvk.to_bytes()))]).unwrap().encode(&NetworkType::Test);
    let f = small();
    assert!(Scan::from_corpus(&f).unwrap().summary().contains("\"key_sha256\":null"), "the synthetic key has no hash to show");
    let mut s = Scan::from_corpus(&f).unwrap();
    s.set_ufvk_inner(&ufvk).unwrap();
    let summary = s.summary();
    let want: String = Sha256::digest(ufvk.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert!(summary.contains(&format!("\"key_sha256\":\"{want}\"")), "{summary}");
    for n in [6, 8, 12, 20] {
        assert!(!summary.contains(&ufvk[..n]), "the first {n} characters of the key are in the summary");
    }
    assert!(!summary.contains("\"key\":"), "{summary}");
}

// Projection data: the size of the compact blocks as they were pushed, kept outside every verdict.
#[test]
fn the_summary_counts_the_bytes_of_the_compact_blocks_it_was_given() {
    let f = small();
    let (_, msgs, _) = corpus::parse(&f).unwrap();
    let sizes: Vec<u64> = msgs.iter().map(|m| m.len() as u64).collect();
    let total: u64 = sizes.iter().sum();
    let mut sorted = sizes.clone();
    sorted.sort();
    let summary = Scan::from_corpus(&f).unwrap().summary();
    assert!(summary.contains(&format!("\"compact_bytes\":{total},")), "{summary}");
    let median = if sorted.len() % 2 == 1 { sorted[sorted.len() / 2] as f64 } else { (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2]) as f64 / 2.0 };
    assert!(summary.contains(&format!("\"compact_bytes_by_block\":{{\"min\":{},\"median\":{},\"max\":{}}}", sorted[0], median, sorted[sorted.len() - 1])), "{summary}");
    // pushed one by one, as a live row does
    let (h, _, _) = corpus::parse(&f).unwrap();
    let mut live = Scan::live(h.start_height, &h.orchard_tree, &h.ironwood_tree).unwrap();
    for m in &msgs {
        live.push_message(m.to_vec()).unwrap();
    }
    assert!(live.summary().contains(&format!("\"compact_bytes\":{total},")));
    // and the count is still there after the stages ran
    let after = all_stages(&f).unwrap().summary();
    assert!(after.contains(&format!("\"compact_bytes\":{total},")), "{after}");
}

// The bare roots the result records
fn root_hex(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn roots_of(summary: &str) -> String {
    let i = summary.find("\"tree_roots\":").expect("tree_roots is in the summary");
    summary[i..].to_string()
}

#[test]
fn the_summary_records_the_bare_roots_the_scan_checks() {
    let f = synth::generate(Params { blocks: 8, ..Default::default() });
    let (h, _, _) = corpus::parse(&f).unwrap();
    let (want_o, want_i) = h.roots.expect("the synthetic corpus carries its end roots");
    let s = all_stages(&f).unwrap();
    // The root the scan checks against the end tree state is the one it exports.
    assert_eq!(s.root_bytes(0).unwrap(), want_o);
    assert_eq!(s.root_bytes(1).unwrap(), want_i);
    // From the start of the chain the trees are empty, so the start root is the empty root.
    let empty = root_hex(konclave_benchmark::tree::empty_root().to_bytes());
    let want = format!(
        "\"tree_roots\":{{\"orchard\":{{\"start\":\"{empty}\",\"end\":\"{}\"}},\"ironwood\":{{\"start\":\"{empty}\",\"end\":\"{}\"}}}}",
        root_hex(want_o),
        root_hex(want_i)
    );
    assert_eq!(roots_of(&s.summary()), format!("{want}}}"));
    // A range from the middle starts from a root that is not the empty one, and ends where the whole chain ends.
    let whole = all_stages(&synth::generate(Params { blocks: 12, ..Default::default() })).unwrap();
    let tail = all_stages(&synth::generate(Params { blocks: 7, skip_blocks: 5, ..Default::default() })).unwrap();
    assert_ne!(tail.start_root_bytes(0), konclave_benchmark::tree::empty_root().to_bytes());
    // It is the root the first five blocks end on, in both pools.
    let head = all_stages(&synth::generate(Params { blocks: 5, ..Default::default() })).unwrap();
    assert_eq!(tail.start_root_bytes(0), head.root_bytes(0).unwrap());
    assert_eq!(tail.start_root_bytes(1), head.root_bytes(1).unwrap());
    assert_eq!(tail.root_bytes(0).unwrap(), whole.root_bytes(0).unwrap());
    // Before the tree stage there is no end root.
    assert!(roots_of(&Scan::from_corpus(&f).unwrap().summary()).contains("\"end\":null"));
}

// new_live runs inside the tree_state stage, whose time is part of the total: it must not compute the start roots.
// This counts the calls the scan makes for them; it cannot see a root taken some other way, so a change to the stages
// is also measured (see the notes of the change), but the one place that is allowed to compute them is summary().
#[test]
fn building_a_scan_computes_no_root_and_summary_computes_the_start_roots() {
    use konclave_benchmark::scan::START_ROOTS_COMPUTED as N;
    use std::sync::atomic::Ordering::Relaxed;
    let f = small();
    let (h, _, _) = corpus::parse(&f).unwrap();
    let before = N.load(Relaxed);
    let s = Scan::live(h.start_height, &h.orchard_tree, &h.ironwood_tree).unwrap();
    let c = Scan::from_corpus(&f).unwrap();
    assert_eq!(N.load(Relaxed), before, "building a scan computed a start root");
    let _ = (s.summary(), c.summary());
    assert!(N.load(Relaxed) >= before + 4, "summary is where the start roots are computed");
}
