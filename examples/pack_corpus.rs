// SPDX-License-Identifier: MIT OR Apache-2.0
//! cargo run --release --example pack_corpus -- <saved.json> <blocks.raw> <out.bin>
//! Takes what scripts/save-range.mjs wrote, and prints the corpus's sha256 line for the record.
use konclave_benchmark::{corpus, pack::pack};

fn field<'a>(json: &'a str, name: &str) -> &'a str {
    let key = format!("\"{name}\":");
    let rest = &json[json.find(&key).unwrap_or_else(|| panic!("no {name}")) + key.len()..];
    rest.trim_start().trim_start_matches('"').split(['"', ',', '}']).next().unwrap()
}
fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex")).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let meta = std::fs::read_to_string(&a[1]).unwrap();
    let raw = std::fs::read(&a[2]).unwrap();
    let mut msgs = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let n = u32::from_le_bytes(raw[i..i + 4].try_into().unwrap()) as usize;
        msgs.push(raw[i + 4..i + 4 + n].to_vec());
        i += 4 + n;
    }
    let (so, si, eo, ei) = (hex(field(&meta, "start_orchard")), hex(field(&meta, "start_ironwood")), hex(field(&meta, "end_orchard")), hex(field(&meta, "end_ironwood")));
    let file = pack(field(&meta, "start").parse().unwrap(), &msgs, [&so, &si], [&eo, &ei]).unwrap();
    corpus::parse(&file).unwrap();
    std::fs::write(&a[3], &file).unwrap();
    let d: String = file[8..40].iter().map(|b| format!("{b:02x}")).collect();
    std::fs::write(format!("{}.sha256", a[3]), format!("{d}\n")).unwrap();
    println!("{} blocks, sha256 {d}", msgs.len());
}
