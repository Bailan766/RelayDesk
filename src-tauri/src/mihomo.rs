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

pub fn prepare_tun_policy(
    config: &Value,
    port: u16,
    mode: RoutingMode,
    dns_port: u16,
    system_dns: Option<u16>,
) -> Result<Value, String> {
    prepare_tun_policy_with_lan(config, port, mode, dns_port, system_dns, false)
}

pub fn prepare_tun_policy_with_lan(
    config: &Value,
    port: u16,
    mode: RoutingMode,
    dns_port: u16,
    system_dns: Option<u16>,
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
            ("use-hosts".into(), json!(true)),
        ]);
    }
    dns.insert("enable".into(), json!(true));
    dns.insert("listen".into(), json!(format!("127.0.0.1:{dns_port}")));
    if let Some(port) = system_dns {
        let local = format!("udp://127.0.0.1:{port}#DIRECT");
        for key in [
            "nameserver",
            "fallback",
            "default-nameserver",
            "proxy-server-nameserver",
            "direct-nameserver",
            "nameserver-policy",
            "proxy-server-nameserver-policy",
        ] {
            if let Some(value) = dns.get_mut(key) {
                use_physical_system_dns(value, &local);
            }
        }
    }
    prepared["dns"] = Value::Object(dns);
    Ok(prepared)
}

fn use_physical_system_dns(value: &mut Value, local: &str) {
    match value {
        Value::String(server)
            if matches!(server.as_str(), "system" | "system://" | "dhcp://system") =>
        {
            *server = local.to_owned();
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| use_physical_system_dns(value, local)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| use_physical_system_dns(value, local)),
        _ => {}
    }
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
    fn tun_uses_the_profile_dns_or_the_system_resolver_on_a_private_port() {
        let configured = json!({
            "rules":["MATCH,DIRECT"],
            "dns":{"enable":true,"listen":"0.0.0.0:53","nameserver":["https://dns.example/query"],
                   "enhanced-mode":"fake-ip"}
        });
        let dns = prepare_tun_policy(&configured, 17070, RoutingMode::Rule, 17071, Some(17072))
            .unwrap()["dns"]
            .clone();
        assert_eq!(dns["listen"], "127.0.0.1:17071");
        assert_eq!(dns["nameserver"], configured["dns"]["nameserver"]);
        assert_eq!(dns["enhanced-mode"], "fake-ip");

        for config in [
            json!({"rules":["MATCH,DIRECT"]}),
            json!({"rules":["MATCH,DIRECT"],"dns":{"enable":false,"nameserver":["127.0.0.2"]}}),
        ] {
            let prepared =
                prepare_tun_policy(&config, 17070, RoutingMode::Rule, 17071, None).unwrap();
            let dns = &prepared["dns"];
            assert_eq!(dns["enable"], true);
            assert_eq!(dns["listen"], "127.0.0.1:17071");
            assert_eq!(dns["nameserver"], json!(["system"]));
        }

        let mut explicit = configured;
        explicit["dns"]["nameserver-policy"] =
            json!({"fixture.test":["system://","dhcp://system"]});
        let prepared =
            prepare_tun_policy(&explicit, 17070, RoutingMode::Rule, 17071, Some(17072)).unwrap();
        assert_eq!(
            prepared["dns"]["nameserver-policy"]["fixture.test"],
            json!([
                "udp://127.0.0.1:17072#DIRECT",
                "udp://127.0.0.1:17072#DIRECT"
            ])
        );
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
