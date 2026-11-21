use crate::{network::RoutingMode, telemetry::Controller};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    hash::{DefaultHasher, Hash, Hasher},
    time::Duration,
};

const TRAFFIC_FIELDS: &[&str] = &[
    "proxies",
    "proxy-groups",
    "proxy-providers",
    "rules",
    "rule-providers",
    "dns",
    "hosts",
    "sniffer",
    "ipv6",
    "find-process-mode",
    "tcp-concurrent",
    "global-client-fingerprint",
    "keep-alive-idle",
    "keep-alive-interval",
    "disable-keep-alive",
    "unified-delay",
    "geodata-mode",
    "geodata-loader",
    "geo-auto-update",
    "geo-update-interval",
    "geox-url",
    "global-ua",
    "etag-support",
];

fn prepare_providers(config: &mut Map<String, Value>, field: &str) -> Result<(), String> {
    let Some(providers) = config.get_mut(field) else {
        return Ok(());
    };
    let providers = providers.as_object_mut().ok_or("提供者配置必须为对象")?;
    for (name, provider) in providers.iter_mut() {
        let provider = provider.as_object_mut().ok_or("提供者配置必须为对象")?;
        match provider.get("type").and_then(Value::as_str) {
            Some("http") => {
                let url = provider
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(|value| url::Url::parse(value).ok())
                    .ok_or("远程提供者需要有效的网址")?;
                if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
                    return Err("远程提供者仅支持 HTTP 或 HTTPS".into());
                }
                let mut identity = DefaultHasher::new();
                name.hash(&mut identity);
                url.as_str().hash(&mut identity);
                provider
                    .get("header")
                    .map(Value::to_string)
                    .hash(&mut identity);
                provider.insert(
                    "path".into(),
                    json!(format!("./{field}/{:016x}.cache", identity.finish())),
                );
            }
            Some("inline") => {
                provider.remove("path");
            }
            Some("file") => return Err("原配置含本地文件提供者，请先改为远程地址或内联内容".into()),
            _ => return Err("原配置含无法识别的提供者类型".into()),
        }
        provider.remove("path-in-bundle");
        let limit = provider
            .get("size-limit")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        const MAX_PROVIDER_BYTES: u64 = 32 * 1024 * 1024;
        if limit == 0 || limit > MAX_PROVIDER_BYTES {
            provider.insert("size-limit".into(), json!(MAX_PROVIDER_BYTES));
        }
    }
    Ok(())
}

pub fn prepare(config: &Value, port: u16, mode: RoutingMode) -> Result<Value, String> {
    prepare_with_lan(config, port, mode, false)
}

pub fn prepare_with_lan(
    config: &Value,
    port: u16,
    mode: RoutingMode,
    allow_lan: bool,
) -> Result<Value, String> {
    let source = config.as_object().ok_or("Mihomo 原配置必须为对象")?;
    if ![
        "proxies",
        "proxy-groups",
        "proxy-providers",
        "rules",
        "rule-providers",
    ]
    .iter()
    .any(|field| source.contains_key(*field))
    {
        return Err("订阅没有可运行的 Mihomo 策略或节点".into());
    }
    let mut config: Map<String, Value> = source
        .iter()
        .filter(|(field, _)| TRAFFIC_FIELDS.contains(&field.as_str()))
        .map(|(field, value)| (field.clone(), value.clone()))
        .collect();
    prepare_providers(&mut config, "proxy-providers")?;
    prepare_providers(&mut config, "rule-providers")?;
    if let Some(dns) = config.get_mut("dns").and_then(Value::as_object_mut) {
        dns.remove("listen");
    }
    config.insert("mixed-port".into(), json!(port));
    config.insert(
        "bind-address".into(),
        json!(if allow_lan { "0.0.0.0" } else { "127.0.0.1" }),
    );
    config.insert("allow-lan".into(), json!(allow_lan));
    config.insert("mode".into(), json!(mode.name()));
    config.insert("log-level".into(), json!("warning"));
    if config.get("disable-keep-alive") != Some(&json!(true)) {
        config.entry("keep-alive-idle").or_insert_with(|| json!(15));
        config
            .entry("keep-alive-interval")
            .or_insert_with(|| json!(15));
    }
    config.entry("tcp-concurrent").or_insert_with(|| json!(true));
    config.entry("unified-delay").or_insert_with(|| json!(true));
    config
        .entry("find-process-mode")
        .or_insert_with(|| json!("always"));
    Ok(Value::Object(config))
}

fn normalize_fake_ip_range(value: &str) -> Option<String> {
    let (ip_str, prefix_str) = value.trim().split_once('/')?;
    let ip: std::net::Ipv4Addr = ip_str.trim().parse().ok()?;
    let prefix: u8 = prefix_str.trim().parse().ok()?;
    if prefix > 30 {
        return None;
    }
    let mut octets = ip.octets();
    match octets[3] % 4 {
        0 => octets[3] += 1,
        3 => octets[3] -= 2,
        _ => {}
    }
    let normalized = std::net::Ipv4Addr::from(octets);
    Some(format!("{normalized}/{prefix}"))
}

pub fn tun_ipv4_address(config: &Value) -> std::net::Ipv4Addr {
    if let Some(raw) = config
        .get("dns")
        .and_then(|d| d.get("fake-ip-range"))
        .and_then(Value::as_str)
    {
        let normalized = normalize_fake_ip_range(raw);
        let candidate = normalized.as_deref().unwrap_or(raw);
        if let Some(ip) = candidate
            .split('/')
            .next()
            .and_then(|host| host.trim().parse::<std::net::Ipv4Addr>().ok())
        {
            return ip;
        }
    }
    std::net::Ipv4Addr::new(198, 18, 0, 1)
}

pub fn prepare_native_tun_with_lan(
    config: &Value,
    port: u16,
    mode: RoutingMode,
    interface: &str,
    tun_ipv6: bool,
    allow_lan: bool,
) -> Result<Value, String> {
    let mut prepared = prepare_with_lan(config, port, mode, allow_lan)?;
    let dns = prepared["dns"].take();
    let mut dns = match dns {
        Value::Object(dns) => dns,
        Value::Null => Map::new(),
        _ => return Err("原配置的 DNS 必须为对象".into()),
    };
    if dns.get("enable") != Some(&json!(true)) {
        dns = Map::from_iter([
            ("nameserver".into(), json!(["system"])),
            ("enhanced-mode".into(), json!("fake-ip")),
            ("fake-ip-range".into(), json!("198.18.0.1/16")),
            ("use-hosts".into(), json!(true)),
        ]);
    }
    if let Some(fixed) = dns
        .get("fake-ip-range")
        .and_then(Value::as_str)
        .and_then(normalize_fake_ip_range)
    {
        dns.insert("fake-ip-range".into(), json!(fixed));
    }
    dns.insert("enable".into(), json!(true));
    dns.remove("listen");
    if tun_ipv6 {
        dns.entry("ipv6").or_insert_with(|| json!(true));
        if prepared.get("ipv6").is_none() {
            prepared["ipv6"] = json!(true);
        }
    }
    prepared["dns"] = Value::Object(dns);

    let mut tun = Map::from_iter([
        ("enable".into(), json!(true)),
        ("device".into(), json!(interface)),
        ("stack".into(), json!("mixed")),
        ("auto-route".into(), json!(true)),
        ("strict-route".into(), json!(true)),
        ("auto-detect-interface".into(), json!(true)),
        ("dns-hijack".into(), json!(["any:53", "tcp://any:53"])),
    ]);
    if tun_ipv6 {
        tun.insert("inet6-address".into(), json!(["fdfe:dcba:9876::1/126"]));
    }
    prepared["tun"] = Value::Object(tun);
    Ok(prepared)
}

pub async fn restore_selections(
    controller: &Controller,
    selections: BTreeMap<String, String>,
    budget: Duration,
) {
    let mut pending = selections;
    let _ = tokio::time::timeout(budget, async {
        while !pending.is_empty() {
            if let Ok(groups) = controller.groups().await {
                for group in groups.into_iter().filter(|group| group.manual) {
                    let Some(choice) = pending.get(&group.name) else {
                        continue;
                    };
                    if group.selected == *choice
                        || (group.choices.contains(choice)
                            && controller.switch_group(&group.name, choice).await.is_ok())
                    {
                        pending.remove(&group.name);
                    }
                }
            }
            if !pending.is_empty() {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_tun_uses_profile_dns_or_fakeip_default_and_sets_single_core_wintun_block() {
        let configured = json!({
            "rules":["MATCH,DIRECT"],
            "dns":{"enable":true,"listen":"0.0.0.0:53","nameserver":["https://dns.example/query"],
                   "enhanced-mode":"fake-ip","fake-ip-range":"198.19.55.0/24"}
        });
        let prepared = prepare_native_tun_with_lan(
            &configured,
            17070,
            RoutingMode::Rule,
            "RelayDesk-test1234",
            true,
            false,
        )
        .unwrap();
        assert_eq!(prepared["dns"]["enable"], true);
        assert!(prepared["dns"].get("listen").is_none());
        assert_eq!(prepared["dns"]["nameserver"], configured["dns"]["nameserver"]);
        assert_eq!(prepared["dns"]["enhanced-mode"], "fake-ip");
        assert_eq!(prepared["dns"]["fake-ip-range"], "198.19.55.1/24");
        assert_eq!(
            tun_ipv4_address(&prepared),
            std::net::Ipv4Addr::new(198, 19, 55, 1)
        );
        assert_eq!(prepared["tun"]["enable"], true);
        assert_eq!(prepared["tun"]["device"], "RelayDesk-test1234");
        assert_eq!(prepared["tun"]["stack"], "mixed");
        assert!(prepared["tun"].get("inet4-address").is_none());
        assert_eq!(prepared["tun"]["inet6-address"], json!(["fdfe:dcba:9876::1/126"]));

        for config in [
            json!({"rules":["MATCH,DIRECT"]}),
            json!({"rules":["MATCH,DIRECT"],"dns":{"enable":false,"nameserver":["127.0.0.2"]}}),
        ] {
            let prepared = prepare_native_tun_with_lan(
                &config,
                17070,
                RoutingMode::Rule,
                "RelayDesk-def",
                false,
                true,
            )
            .unwrap();
            assert_eq!(prepared["allow-lan"], true);
            assert!(prepared["tun"].get("inet4-address").is_none());
            assert!(prepared["tun"].get("inet6-address").is_none());
            assert_eq!(prepared["dns"]["enable"], true);
            assert_eq!(prepared["dns"]["enhanced-mode"], "fake-ip");
            assert_eq!(prepared["dns"]["fake-ip-range"], "198.18.0.1/16");
            assert_eq!(
                tun_ipv4_address(&prepared),
                std::net::Ipv4Addr::new(198, 18, 0, 1)
            );
            assert_eq!(prepared["dns"]["nameserver"], json!(["system"]));
        }
    }

    #[test]
    fn preserves_user_routing_and_owns_network_listeners_and_provider_paths() {
        let input = json!({
            "mixed-port": 9090, "external-controller":"0.0.0.0:9090", "allow-lan": true,
            "tun":{"enable":true}, "listeners":[{"name":"fixture"}],
            "dns":{"enable":true,"listen":"0.0.0.0:5353","nameserver":["https://dns.example/query"]},
            "rules":["RULE-SET,remote,group","MATCH,REJECT"],
            "proxy-groups":[{"name":"group","type":"select","proxies":["DIRECT"]}],
            "rule-providers":{"remote":{"type":"http","url":"https://fixture.test/rules","path":"../outside","size-limit":1024,"behavior":"classical"}}
        });
        let output = prepare(&input, 17071, RoutingMode::Rule).unwrap();
        assert_eq!(output["mixed-port"], 17071);
        assert_eq!(output["bind-address"], "127.0.0.1");
        assert_eq!(output["allow-lan"], false);
        for field in ["external-controller", "tun", "listeners"] {
            assert!(output.get(field).is_none());
        }
        assert!(output["dns"].get("listen").is_none());
        assert_eq!(output["dns"]["nameserver"], input["dns"]["nameserver"]);
        assert_eq!(output["rules"], input["rules"]);
        assert_eq!(output["proxy-groups"], input["proxy-groups"]);
        let path = output["rule-providers"]["remote"]["path"].as_str().unwrap();
        assert!(path.starts_with("./rule-providers/") && path.ends_with(".cache"));
        let mut changed = input.clone();
        changed["rule-providers"]["remote"]["url"] = json!("https://fixture.test/changed");
        let changed = prepare(&changed, 17071, RoutingMode::Rule).unwrap();
        assert_ne!(
            changed["rule-providers"]["remote"]["path"].as_str(),
            Some(path)
        );
        assert_eq!(output["rule-providers"]["remote"]["size-limit"], 1024);
        assert!(prepare(
            &json!({"rule-providers":{"local":{"type":"file","path":"../outside"}}}),
            17071,
            RoutingMode::Rule
        )
        .is_err());
    }
}
