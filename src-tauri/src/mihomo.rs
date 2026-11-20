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
    config.insert("bind-address".into(), json!("127.0.0.1"));
    config.insert("allow-lan".into(), json!(false));
    config.insert("mode".into(), json!(mode.name()));
    config.insert("log-level".into(), json!("warning"));
    Ok(Value::Object(config))
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
