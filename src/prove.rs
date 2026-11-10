// SPDX-License-Identifier: MIT OR Apache-2.0
//! Proving: the real Halo2 Action circuit of orchard 0.16.0, for the circuit of the chosen pool, over a bundle built
//! here with the orchard builder (zero-value change outputs, padded to 2 actions by the builder, fixed seed). Each
//! phase is its own call so the page can time them apart: the key build is a real part of what a member waits for,
//! and is reported apart from the proof. Nothing here touches a vault, a key that owns anything, or a network.
use orchard::{
    builder::{Builder, BundleType, InProgress, Unauthorized, Unproven},
    bundle::BundleVersion,
    circuit::{OrchardCircuitVersion, ProvingKey, VerifyingKey},
    keys::{FullViewingKey, Scope, SpendAuthorizingKey, SpendingKey},
    value::NoteValue,
    Anchor, Bundle, Proof,
};
use rand::{rngs::StdRng, SeedableRng};
use wasm_bindgen::prelude::*;

pub(crate) const KEY_SEED: [u8; 32] = [7u8; 32];
const RNG_SEED: u64 = 0x4b6f_6e63_6c61_7665; // "Konclave"
const MAX_OUTPUTS: u32 = 64;

fn parse(pool: &str) -> Result<(BundleVersion, OrchardCircuitVersion), String> {
    match pool {
        "orchard-v2" => Ok((
            BundleVersion::orchard_v2(),
            OrchardCircuitVersion::FixedPostNu6_2,
        )),
        "ironwood-v3" => Ok((
            BundleVersion::ironwood_v3(),
            OrchardCircuitVersion::PostNu6_3,
        )),
        other => Err(format!("unknown pool {other}")),
    }
}

type UnprovenBundle = Bundle<InProgress<Unproven, Unauthorized>, i64>;
type ProvenBundle = Bundle<InProgress<Proof, Unauthorized>, i64>;

#[wasm_bindgen]
pub struct Prove {
    bundle_version: BundleVersion,
    circuit: OrchardCircuitVersion,
    pk: Option<ProvingKey>,
    vk: Option<VerifyingKey>,
    unproven: Option<UnprovenBundle>,
    proven: Option<ProvenBundle>,
    rounds: u32,
}

impl Prove {
    pub fn create(pool: &str) -> Result<Prove, String> {
        let (bundle_version, circuit) = parse(pool)?;
        Ok(Prove {
            bundle_version,
            circuit,
            pk: None,
            vk: None,
            unproven: None,
            proven: None,
            rounds: 0,
        })
    }

    pub fn prepare_inner(&mut self, outputs: u32) -> Result<u32, String> {
        if outputs == 0 || outputs > MAX_OUTPUTS {
            return Err(format!("outputs must be 1 to {MAX_OUTPUTS}, got {outputs}"));
        }
        let sk =
            Option::<SpendingKey>::from(SpendingKey::from_bytes(KEY_SEED)).ok_or("bad seed")?;
        let fvk = FullViewingKey::from(&sk);
        let addr = fvk.address_at(0u32, Scope::External);
        let flags = self.bundle_version.default_flags();
        let mut b = Builder::new(
            BundleType::DEFAULT,
            self.bundle_version,
            flags,
            Anchor::empty_tree(),
        )
        .map_err(|e| format!("{e:?}"))?;
        for _ in 0..outputs {
            b.add_change_output(fvk.clone(), None, addr, NoteValue::from_raw(0), [0u8; 512])
                .map_err(|e| format!("{e:?}"))?;
        }
        let mut rng = StdRng::seed_from_u64(RNG_SEED);
        let built = b.build::<i64>(&mut rng).map_err(|e| format!("{e:?}"))?;
        let bundle = built.map(|(bundle, _)| bundle).ok_or("empty bundle")?;
        let n = bundle.actions().len() as u32;
        self.unproven = Some(bundle);
        Ok(n)
    }

    pub fn prove_inner(&mut self) -> Result<(), String> {
        let pk = self.pk.as_ref().ok_or("build_key first")?;
        let bundle = self.unproven.take().ok_or("prepare first")?;
        let mut rng = StdRng::seed_from_u64(RNG_SEED ^ 1);
        self.proven = Some(
            bundle
                .create_proof(pk, &mut rng)
                .map_err(|e| format!("{e:?}"))?,
        );
        self.rounds += 1;
        Ok(())
    }

    pub fn verify_inner(&mut self) -> Result<(), String> {
        let proven = self.proven.take().ok_or("prove first")?;
        if self.vk.is_none() {
            self.vk = Some(VerifyingKey::build(self.circuit));
        }
        let sk =
            Option::<SpendingKey>::from(SpendingKey::from_bytes(KEY_SEED)).ok_or("bad seed")?;
        let ask = SpendAuthorizingKey::from(&sk);
        let mut rng = StdRng::seed_from_u64(RNG_SEED ^ 2);
        let authorized = proven
            .apply_signatures(&mut rng, [0u8; 32], &[ask])
            .map_err(|e| format!("{e:?}"))?;
        authorized
            .verify_proof(self.vk.as_ref().unwrap())
            .map_err(|e| format!("proof did not verify: {e:?}"))
    }

    pub fn set_wrong_verifying_key_for_test(&mut self) {
        let other = match self.circuit {
            OrchardCircuitVersion::PostNu6_3 => OrchardCircuitVersion::FixedPostNu6_2,
            _ => OrchardCircuitVersion::PostNu6_3,
        };
        self.vk = Some(VerifyingKey::build(other));
    }
}

#[wasm_bindgen]
impl Prove {
    #[wasm_bindgen(constructor)]
    pub fn new(pool: &str) -> Result<Prove, JsError> {
        Self::create(pool).map_err(|e| JsError::new(&e))
    }
    /// Builds the proving key in this page (there is no download and no way to keep it).
    pub fn build_key(&mut self) {
        self.pk = Some(ProvingKey::build(self.circuit));
    }
    /// Builds an unproven bundle; returns its action count, max(2, outputs).
    pub fn prepare(&mut self, outputs: u32) -> Result<u32, JsError> {
        self.prepare_inner(outputs).map_err(|e| JsError::new(&e))
    }
    pub fn prove(&mut self) -> Result<(), JsError> {
        self.prove_inner().map_err(|e| JsError::new(&e))
    }
    pub fn verify(&mut self) -> Result<(), JsError> {
        self.verify_inner().map_err(|e| JsError::new(&e))
    }
    /// Whether this instance already holds a proving key: false until build_key ran in it, so a run can say from the wasm's own state
    /// whether its key build was the first one.
    pub fn has_key(&self) -> bool {
        self.pk.is_some()
    }
    /// How many proofs this key has made: the first one is the one a member waits for.
    pub fn rounds(&self) -> u32 {
        self.rounds
    }
}
