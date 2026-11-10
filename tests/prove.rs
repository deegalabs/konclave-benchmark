// SPDX-License-Identifier: MIT OR Apache-2.0
use konclave_benchmark::prove::Prove;

fn key(p: &mut Prove) {
    p.build_key();
}

#[test]
fn n_outputs_give_the_expected_actions_and_verify() {
    for pool in ["orchard-v2", "ironwood-v3"] {
        let mut p = Prove::create(pool).unwrap();
        key(&mut p);
        for (outputs, actions) in [(1u32, 2u32), (4, 4)] {
            assert_eq!(p.prepare_inner(outputs).unwrap(), actions, "{pool}");
            p.prove_inner().unwrap();
            p.verify_inner().unwrap();
        }
        assert_eq!(p.rounds(), 2);
    }
}

#[test]
fn a_proof_does_not_verify_under_the_other_circuit() {
    let mut p = Prove::create("ironwood-v3").unwrap();
    key(&mut p);
    p.prepare_inner(1).unwrap();
    p.prove_inner().unwrap();
    p.set_wrong_verifying_key_for_test();
    assert!(p.verify_inner().unwrap_err().contains("did not verify"));
}

#[test]
fn proving_needs_a_key_and_a_bundle_and_bad_input_is_refused() {
    assert!(Prove::create("sapling").is_err());
    let mut p = Prove::create("ironwood-v3").unwrap();
    assert!(p.prepare_inner(0).is_err());
    assert!(p.prepare_inner(65).is_err());
    p.prepare_inner(1).unwrap();
    assert_eq!(p.prove_inner().unwrap_err(), "build_key first");
}

#[test]
fn the_key_is_there_only_after_it_was_built_in_this_instance() {
    let mut p = Prove::create("ironwood-v3").unwrap();
    assert!(!p.has_key(), "a fresh instance holds no key");
    key(&mut p);
    assert!(p.has_key());
    assert_eq!(p.rounds(), 0);
}
