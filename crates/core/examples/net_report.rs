//! Diagnostic: what this network allows for direct P2P (hole punching). `cargo run --example net_report`
use iroh::{Endpoint, Watcher, endpoint::presets};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ep = Endpoint::bind(presets::N0).await?;
    ep.online().await;
    let r = ep.net_report().initialized().await;
    let mask = |s: Option<String>| {
        s.map(|x| {
            x.split(':')
                .next()
                .unwrap_or("")
                .chars()
                .take(6)
                .collect::<String>()
                + "…"
        })
    };
    println!("udp_v4={} udp_v6={}", r.udp_v4, r.udp_v6);
    println!(
        "ipv4 mapping varies by destination (symmetric NAT) = {:?}",
        r.mapping_varies_by_dest_ipv4
    );
    println!(
        "ipv6 mapping varies by destination = {:?}",
        r.mapping_varies_by_dest_ipv6
    );
    println!(
        "global v4 = {:?}, global v6 = {:?}",
        mask(r.global_v4.map(|a| a.to_string())),
        r.global_v6.is_some()
    );
    println!("preferred relay = {:?}", r.preferred_relay);
    ep.close().await;
    Ok(())
}
