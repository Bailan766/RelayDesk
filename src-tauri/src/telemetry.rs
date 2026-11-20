use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{net::TcpListener, sync::OnceLock, time::Duration};

static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();

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

    pub fn configure(&self, config: &mut Value) {
        config["experimental"] = json!({
            "clash_api": {
                "external_controller": format!("127.0.0.1:{}", self.port),
                "secret": self.secret.to_string(),
                "access_control_allow_origin": ["http://127.0.0.1"]
            }
        });
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
        let response = self
            .request(reqwest::Method::PUT, "/proxies/proxy")?
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

    pub async fn snapshot(&self) -> Result<Snapshot, String> {
        let mut response = self
            .request(reqwest::Method::GET, "/connections")?
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
