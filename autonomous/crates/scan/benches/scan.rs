//! cargo bench -p sikrets-scan

use divan::{Bencher, black_box};
use sikrets_scan::{AccessGraph, Graph, scan};

fn main() {
    divan::main();
}

/// A large org: 20k humans, 20k devices, 2k CI runners, 10k packages, 5k services, 1k critical
/// resources; ~250k edges, of which a small share reach something critical.
fn org() -> Graph {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut x = 0x9E3779B97F4A7C15u64;
    let mut rnd = |n: u64| {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x % n
    };
    let groups = [
        ("h", "human", 20_000),
        ("d", "device", 20_000),
        ("c", "ci", 2_000),
        ("p", "package", 10_000),
        ("s", "service", 5_000),
        ("r", "resource", 1_000),
    ];
    for (prefix, ty, n) in groups {
        for i in 0..n {
            let critical = prefix == "r" && i % 10 == 0;
            nodes.push(format!(r#""{prefix}{i}":{{"type":"{ty}","critical":{critical}}}"#));
        }
    }
    let mut edge = |from: String, to: String, kinds: &str, standing: bool| {
        edges.push(format!(r#"{{"from":"{from}","to":"{to}","via":"x","kinds":[{kinds}],"standing":{standing}}}"#));
    };
    for i in 0..20_000 {
        edge(format!("h{i}"), format!("d{i}"), r#""admin""#, true);
        for _ in 0..3 {
            edge(format!("d{i}"), format!("s{}", rnd(5_000)), r#""admin""#, rnd(20) == 0);
        }
    }
    for i in 0..10_000 {
        edge(format!("p{i}"), format!("c{}", rnd(2_000)), r#""write""#, true);
    }
    for i in 0..2_000 {
        for _ in 0..10 {
            edge(format!("c{i}"), format!("s{}", rnd(5_000)), r#""admin""#, rnd(10) == 0);
        }
    }
    for i in 0..5_000 {
        for _ in 0..20 {
            let kinds = if rnd(50) == 0 { r#""transfer","sign""# } else { r#""read""# };
            edge(format!("s{i}"), format!("r{}", rnd(1_000)), kinds, true);
        }
    }
    serde_json::from_str(&format!(r#"{{"nodes":{{{}}},"edges":[{}]}}"#, nodes.join(","), edges.join(","))).unwrap()
}

#[divan::bench(sample_count = 20)]
fn scan_large_org(b: Bencher) {
    let g = AccessGraph::new(org()).unwrap();
    let r = scan(&g, None);
    eprintln!("nodes {} edges {} entries {} exposed {}", g.graph().nodes.len(), g.graph().edges.len(), r.entries, r.exposed_entries);
    b.bench_local(|| black_box(scan(black_box(&g), None)));
}
