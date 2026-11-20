use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::OnceLock,
    time::Duration,
};

static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
static LOG_CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
pub struct Controller {
    port: u16,
    secret: uuid::Uuid,
}

impl Controller {
    pub fn new(proxy_port: u16) -> Result<Self, String> {
        let mut listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "无法分配监控端口")?;
        let mut port = listener
            .local_addr()
            .map_err(|_| "无法读取监控端口")?
            .port();
        if port == proxy_port {
            listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "无法分配监控端口")?;
            port = listener
                .local_addr()
                .map_err(|_| "无法读取监控端口")?
                .port();
        }
        Ok(Self {
            port,
            secret: uuid::Uuid::new_v4(),
        })
    }

    pub fn configure(&self, config: &mut Value, default_mode: &str) {
        config["experimental"] = json!({
            "clash_api": {
                "external_controller": format!("127.0.0.1:{}", self.port),
                "secret": self.secret.to_string(),
                "default_mode": default_mode,
                "access_control_allow_origin": ["http://127.0.0.1"]
            }
        });
    }

    pub fn configure_mihomo(&self, config: &mut Value) {
        config["external-controller"] = json!(format!("127.0.0.1:{}", self.port));
        config["secret"] = json!(self.secret.to_string());
    }

    pub fn ready(&self) -> bool {
        let address = SocketAddr::from(([127, 0, 0, 1], self.port));
        let timeout = Duration::from_millis(150);
        let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
            return false;
        };
        if stream.set_read_timeout(Some(timeout)).is_err()
            || stream.set_write_timeout(Some(timeout)).is_err()
        {
            return false;
        }
        let request = format!("GET /version HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
            self.port, self.secret);
        if stream.write_all(request.as_bytes()).is_err() {
            return false;
        }
        let reader = BufReader::with_capacity(128, stream);
        reader.take(128).split(b'\n').next().is_some_and(|line| {
            line.is_ok_and(|line| {
                line.starts_with(b"HTTP/1.1 200 ") || line.starts_with(b"HTTP/1.0 200 ")
            })
        })
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        let client = CLIENT
            .get_or_init(|| {
                reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(2))
                    .build()
            })
            .as_ref()
            .map_err(|_| "无法初始化内核监控")?;
        Ok(client
            .request(method, format!("http://127.0.0.1:{}{path}", self.port))
            .bearer_auth(self.secret.to_string()))
    }

    pub async fn switch(&self, tag: &str) -> Result<(), String> {
        self.choose("/proxies/proxy", tag).await
    }

    pub async fn switch_group(&self, group: &str, choice: &str) -> Result<(), String> {
        if group.is_empty()
            || group.len() > 512
            || matches!(group, "." | "..")
            || choice.is_empty()
            || choice.len() > 512
        {
            return Err("策略组或节点名称无效".into());
        }
        let mut url = url::Url::parse("http://127.0.0.1/proxies/").map_err(|_| "策略组地址无效")?;
        url.path_segments_mut()
            .map_err(|_| "策略组地址无效")?
            .pop_if_empty()
            .push(group);
        self.choose(url.path(), choice).await
    }

    async fn choose(&self, path: &str, tag: &str) -> Result<(), String> {
        let response = self
            .request(reqwest::Method::PUT, path)?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(json!({ "name": tag }).to_string())
            .send()
            .await
            .map_err(|_| "连接内核控制接口失败")?;
        if response.status().is_success() {
            return Ok(());
        }
        Err("内核未接受节点切换".into())
    }

    pub async fn groups(&self) -> Result<Vec<ProxyGroup>, String> {
        #[derive(Deserialize)]
        struct List {
            proxies: std::collections::BTreeMap<String, GroupStatus>,
        }
        #[derive(Deserialize)]
        struct GroupStatus {
            #[serde(rename = "type")]
            kind: String,
            now: Option<String>,
            all: Option<Vec<String>>,
        }
        let list: List = self.read_json("/proxies").await?;
        Ok(list
            .proxies
            .into_iter()
            .filter_map(|(name, group)| {
                let choices = group.all.filter(|choices| !choices.is_empty())?;
                Some(ProxyGroup {
                    manual: group.kind.eq_ignore_ascii_case("selector"),
                    name,
                    kind: group.kind,
                    selected: group.now.unwrap_or_default(),
                    choices,
                })
            })
            .collect())
    }

    pub async fn reload_mihomo(&self, mut config: Value) -> Result<bool, String> {
        self.configure_mihomo(&mut config);
        let payload = serde_json::to_string(&config).map_err(|_| "无法读取订阅配置")?;
        let response = self
            .request(reqwest::Method::PUT, "/configs?force=true")?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(Duration::from_secs(24))
            .body(json!({ "payload": payload }).to_string())
            .send()
            .await
            .map_err(|_| "Mihomo 更新响应超时或中断")?;
        match response.status().as_u16() {
            204 => Ok(true),
            400 => Ok(false),
            _ => Err("Mihomo 更新返回异常".into()),
        }
    }

    pub async fn probe_outbound(&self, tag: &str, url: &str) -> Option<bool> {
        let path = format!("/proxies/{tag}/delay");
        let response = self
            .request(reqwest::Method::GET, &path)
            .ok()?
            .query(&[("timeout", "4200"), ("url", url)])
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .ok()?;
        match response.status().as_u16() {
            200 => Some(true),
            503 | 504 => Some(false),
            _ => None,
        }
    }

    pub async fn routing_mode(&self, mode: &str) -> Result<(), String> {
        let response = self
            .request(reqwest::Method::PATCH, "/configs")?
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(json!({ "mode": mode }).to_string())
            .send()
            .await
            .map_err(|_| "连接内核控制接口失败")?;
        if !response.status().is_success() {
            return Err("内核未接受路由模式".into());
        }
        let status = self
            .request(reqwest::Method::GET, "/configs")?
            .send()
            .await
            .map_err(|_| "读取内核路由模式失败")?
            .text()
            .await
            .map_err(|_| "读取内核路由模式失败")?;
        let body: Value = serde_json::from_str(&status).map_err(|_| "内核路由模式响应无效")?;
        if body["mode"]
            .as_str()
            .is_some_and(|active| active.eq_ignore_ascii_case(mode))
        {
            Ok(())
        } else {
            Err("内核未切换路由模式".into())
        }
    }

    pub async fn snapshot(&self) -> Result<Snapshot, String> {
        self.read_json("/connections").await
    }

    async fn read_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let mut response = self
            .request(reqwest::Method::GET, path)?
            .send()
            .await
            .map_err(|_| "内核监控暂时不可用")?
            .error_for_status()
            .map_err(|_| "内核监控返回异常")?;
        const LIMIT: usize = 8 * 1024 * 1024;
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "读取内核监控失败")? {
            if data.len() + chunk.len() > LIMIT {
                return Err("内核监控响应过大".into());
            }
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).map_err(|_| "内核监控数据格式无效".into())
    }

    pub async fn stream_logs(
        &self,
        still_current: impl Fn() -> bool,
        mut receive: impl FnMut(&'static str, &'static str),
    ) {
        let Ok(client) = LOG_CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
        }) else {
            return;
        };
        let request = client
            .get(format!("http://127.0.0.1:{}/logs?level=warn", self.port))
            .bearer_auth(self.secret.to_string());
        let Ok(Ok(mut response)) =
            tokio::time::timeout(Duration::from_secs(45), request.send()).await
        else {
            return;
        };
        if !response.status().is_success() {
            return;
        }
        let mut pending = Vec::new();
        while still_current() {
            match tokio::time::timeout(Duration::from_secs(4), response.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    if pending.len() + chunk.len() > 64 * 1024 {
                        return;
                    }
                    pending.extend_from_slice(&chunk);
                    log_lines(&mut pending, &mut receive);
                }
                Ok(_) => return,
                Err(_) => continue,
            }
        }
    }
}

#[derive(Serialize)]
pub struct ProxyGroup {
    pub name: String,
    kind: String,
    pub selected: String,
    pub choices: Vec<String>,
    pub manual: bool,
}

#[derive(Deserialize)]
struct CoreLog {
    #[serde(rename = "type")]
    level: String,
    payload: String,
}

fn log_lines(buffer: &mut Vec<u8>, receive: &mut impl FnMut(&'static str, &'static str)) {
    let Some(end) = buffer.iter().rposition(|byte| *byte == b'\n') else {
        return;
    };
    for line in buffer
        .drain(..=end)
        .collect::<Vec<_>>()
        .split(|byte| *byte == b'\n')
    {
        let Ok(entry) = serde_json::from_slice::<CoreLog>(line) else {
            continue;
        };
        let level = match entry.level.as_str() {
            "error" | "fatal" | "panic" => "error",
            "warning" | "warn" => "warn",
            _ => continue,
        };
        let payload = entry.payload.to_ascii_lowercase();
        let message = if payload.contains("certificate")
            || payload.contains("tls handshake")
            || payload.contains("x509")
        {
            "内核报告 TLS 握手或证书校验异常"
        } else if payload.contains("authentication") || payload.contains("invalid password") {
            "内核报告代理认证异常"
        } else if payload.contains("dns:")
            || payload.contains("lookup ")
            || payload.contains("resolve domain")
        {
            "内核报告 DNS 请求异常"
        } else if payload.contains("wintun") || payload.contains("inbound/tun") {
            "内核报告 TUN 网卡或路由异常"
        } else if payload.contains("timeout")
            || payload.contains("deadline exceeded")
            || payload.contains("context deadline")
        {
            "内核报告请求超时"
        } else if payload.contains("connect") || payload.contains("dial ") {
            "内核报告连接异常"
        } else {
            "内核报告网络处理异常"
        };
        receive(level, message);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_split_records_and_discards_all_remote_text() {
        let mut buffer =
            b"{\"type\":\"error\",\"payload\":\"TLS handshake for secret.example".to_vec();
        let mut events = Vec::new();
        super::log_lines(&mut buffer, &mut |level, message| {
            events.push((level, message))
        });
        assert!(events.is_empty());
        buffer.extend_from_slice(
            b"\"}\n{\"type\":\"warn\",\"payload\":\"lookup private.example\"}\n",
        );
        super::log_lines(&mut buffer, &mut |level, message| {
            events.push((level, message))
        });
        assert_eq!(
            events,
            [
                ("error", "内核报告 TLS 握手或证书校验异常"),
                ("warn", "内核报告 DNS 请求异常")
            ]
        );
        assert!(buffer.is_empty());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    #[serde(flatten)]
    pub snapshot: Snapshot,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    upload_total: u64,
    download_total: u64,
    memory: Option<u64>,
    connections: Vec<Connection>,
}

#[derive(Deserialize, Serialize)]
struct Connection {
    id: String,
    metadata: Metadata,
    upload: u64,
    download: u64,
    chains: Option<Vec<String>>,
    rule: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    host: Option<String>,
    #[serde(rename = "sourceIP")]
    source_ip: Option<String>,
    source_port: Option<String>,
    #[serde(rename = "destinationIP")]
    destination_ip: Option<String>,
    destination_port: Option<String>,
    network: String,
    #[serde(rename = "type")]
    inbound: String,
}
