use super::*;

const GRAPH: &str = r#"{
  "nodes": {
    "alice": { "type": "human" },
    "ops-laptop": { "type": "device" },
    "ci-runner": { "type": "ci" },
    "withdrawal-svc": { "type": "service" },
    "hot-wallet": { "type": "resource", "critical": true },
    "docs": { "type": "resource" }
  },
  "edges": [
    { "from": "alice", "to": "ops-laptop", "via": "logs in", "kinds": ["admin"] },
    { "from": "ops-laptop", "to": "withdrawal-svc", "via": "kubectl exec", "kinds": ["admin"] },
    { "from": "withdrawal-svc", "to": "hot-wallet", "via": "signing API", "kinds": ["transfer", "delegate", "sign"] },
    { "from": "ci-runner", "to": "docs", "via": "deploy", "kinds": ["write"] }
  ]
}"#;

fn graph() -> Graph {
    serde_json::from_str(GRAPH).unwrap()
}

fn run(g: Graph, policy: Option<&Engine>) -> Report {
    scan(&AccessGraph::new(g).unwrap(), policy)
}

#[test]
fn finds_the_laptop_to_wallet_path() {
    let r = run(graph(), None);
    assert_eq!(r.entries, 3);
    assert_eq!(r.exposed_entries, 2, "alice and her laptop; not the CI runner");
    let Finding::ExposedPath { entry, path, resource, .. } =
        r.findings.iter().find(|f| matches!(f, Finding::ExposedPath { entry, .. } if entry == "ops-laptop")).unwrap()
    else {
        unreachable!()
    };
    assert_eq!(entry, "ops-laptop");
    assert_eq!(resource, "hot-wallet");
    let hops: Vec<_> = path.iter().map(|h| h.to.as_str()).collect();
    assert_eq!(hops, ["withdrawal-svc", "hot-wallet"]);
    assert!(r.findings.iter().any(|f| matches!(f, Finding::MissingGuardrail { guardrail: Guardrail::Policy, .. })));
}

#[test]
fn requiring_grants_closes_the_path() {
    let policy = Engine::from_json(
        r#"{"resources":{"hot-wallet":{"allow":["transfer"],"requires_grant":true,"destinations":["cold"],
            "approval_over":"$5m","ceilings":[{"window":"10m","max":"$20m"}]}}}"#,
    )
    .unwrap();
    let r = run(graph(), Some(&policy));
    assert_eq!(r.exposed_entries, 0);
    assert!(r.findings.is_empty(), "{:#?}", r.findings);
}

#[test]
fn a_weak_policy_is_called_out() {
    let policy = Engine::from_json(r#"{"resources":{"hot-wallet":{"allow":["transfer","delegate"]}}}"#).unwrap();
    let r = run(graph(), Some(&policy));
    let missing: Vec<Guardrail> = r
        .findings
        .iter()
        .filter_map(|f| match f {
            Finding::MissingGuardrail { guardrail, .. } => Some(*guardrail),
            _ => None,
        })
        .collect();
    for g in
        [Guardrail::Grants, Guardrail::NoDelegation, Guardrail::DestinationAllowlist, Guardrail::ApprovalThreshold, Guardrail::ValueCeiling]
    {
        assert!(missing.contains(&g), "missing {g:?} in {missing:?}");
    }
    assert_eq!(r.exposed_entries, 2, "no grants, so the path is still open");
}

#[test]
fn granted_edges_are_not_paths() {
    let mut g = graph();
    g.edges[1].standing = false; // laptop → service now needs a grant
    let r = run(g, None);
    assert_eq!(r.exposed_entries, 0);
}

#[test]
fn unknown_nodes_are_errors() {
    let mut g = graph();
    g.edges[0].to = "nobody".into();
    assert!(AccessGraph::new(g).is_err());
}
