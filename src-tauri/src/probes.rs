use serde_json::Value;
use std::{net::SocketAddr, path::Path, process::Stdio, sync::Mutex, time::Duration};
use tokio::{io::AsyncWriteExt, process::Child, sync::watch};

const DOWNLOAD_LIMIT: u64 = 8 * 1024 * 1024;
static DOWNLOAD_SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(serde::Serialize)]
pub struct DownloadMeasurement {
    pub bytes: u64,
    pub milliseconds: u64,
    pub megabits_per_second: f64,
}

#[derive(serde::Serialize)]
pub struct ExitIpDetail {
    pub ip: String,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub isp: Option<String>,
}

#[derive(serde::Serialize)]
pub struct UnlockResult {
    pub service: String,
    pub status: &'static str,
    pub region: Option<String>,
    pub detail: String,
    pub milliseconds: u64,
}

pub async fn check_exit_ip_detail(port: u16) -> Result<ExitIpDetail, String> {
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化出口检查")?;
    if let Ok(response) = client.get("https://ipwho.is/").send().await {
        if response.status().is_success() {
            if let Ok(bytes) = response.bytes().await {
                if let Ok(body) = serde_json::from_slice::<Value>(&bytes) {
                    if body.get("success").and_then(Value::as_bool) != Some(false) {
                        if let Some(ip_str) = body.get("ip").and_then(Value::as_str) {
                            if ip_str.trim().parse::<std::net::IpAddr>().is_ok() {
                                let non_empty = |v: Option<&str>| {
                                    v.map(str::trim)
                                        .filter(|s| !s.is_empty())
                                        .map(str::to_owned)
                                };
                                return Ok(ExitIpDetail {
                                    ip: ip_str.trim().to_owned(),
                                    country: non_empty(body.get("country").and_then(Value::as_str)),
                                    region: non_empty(body.get("region").and_then(Value::as_str)),
                                    city: non_empty(body.get("city").and_then(Value::as_str)),
                                    isp: non_empty(
                                        body.get("connection")
                                            .and_then(|c| c.get("isp"))
                                            .and_then(Value::as_str),
                                    ),
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    let response = client
        .get("https://api.ipify.org")
        .send()
        .await
        .map_err(|_| "出口地址检查失败")?
        .error_for_status()
        .map_err(|_| "出口地址服务异常")?;
    let text = response.text().await.map_err(|_| "读取出口地址失败")?;
    let ip: std::net::IpAddr = text
        .trim()
        .parse()
        .map_err(|_| "出口地址服务返回无效数据")?;
    Ok(ExitIpDetail {
        ip: ip.to_string(),
        country: None,
        region: None,
        city: None,
        isp: None,
    })
}

pub async fn check_unlock_service(service: &str, port: u16) -> Result<UnlockResult, String> {
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .timeout(Duration::from_secs(9))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|_| "无法初始化解锁测试")?;
    const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    let started = std::time::Instant::now();
    let get = |url: &str| client.get(url).header(reqwest::header::USER_AGENT, UA).send();
    let cf_region = |body: &str| -> Option<String> {
        body.lines()
            .find_map(|line| line.strip_prefix("loc="))
            .map(str::trim)
            .filter(|loc| !loc.is_empty())
            .map(str::to_owned)
    };
    let (status, region, detail) = match service {
        "ChatGPT Web" => match get("https://chatgpt.com/cdn-cgi/trace").await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.unwrap_or_default();
                let loc = cf_region(&text);
                if matches!(loc.as_deref(), Some("CN" | "HK" | "RU" | "BY" | "IR" | "KP")) {
                    ("blocked", loc, "所在地区不在支持范围".to_owned())
                } else {
                    ("available", loc, "可访问 Web 入口".to_owned())
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "ChatGPT iOS" => {
            match get("https://ios.chat.openai.com/public-api/mobile/server_status/v1").await {
                Ok(resp) if resp.status().is_success() => {
                    ("available", None, "API 接口可访问".to_owned())
                }
                Ok(resp) if resp.status().as_u16() == 403 => {
                    ("blocked", None, "IP 或地区受限 (403)".to_owned())
                }
                Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
                Err(_) => ("error", None, "请求失败或超时".to_owned()),
            }
        }
        "Claude" => match get("https://claude.ai/cdn-cgi/trace").await {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.unwrap_or_default();
                let loc = cf_region(&text);
                if matches!(loc.as_deref(), Some("CN" | "HK" | "MO" | "RU" | "BY")) {
                    ("blocked", loc, "所在地区不受支持".to_owned())
                } else {
                    match get("https://claude.ai/login").await {
                        Ok(login) if login.status().as_u16() < 400 => {
                            ("available", loc, "登录页可正常访问".to_owned())
                        }
                        Ok(login) => ("blocked", loc, format!("HTTP {}", login.status().as_u16())),
                        Err(_) => ("error", loc, "登录页连接超时".to_owned()),
                    }
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "Gemini" => match get("https://gemini.google.com/").await {
            Ok(resp) if resp.status().is_success() => {
                let final_url = resp.url().as_str().to_owned();
                let body = resp.text().await.unwrap_or_default();
                if final_url.contains("unavailable") || body.contains("not available in your country")
                {
                    ("blocked", None, "所在地区暂不可用".to_owned())
                } else {
                    ("available", None, "页面可访问".to_owned())
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "Netflix" => match get("https://www.netflix.com/title/81280792").await {
            Ok(resp) if resp.status().is_success() => {
                let region = resp
                    .url()
                    .path_segments()
                    .and_then(|mut segs| segs.next())
                    .filter(|s| s.len() == 2 || (s.len() == 5 && s.contains('-')))
                    .map(|s| s.to_uppercase());
                ("available", region, "完整解锁非自制剧".to_owned())
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                match get("https://www.netflix.com/title/80018499").await {
                    Ok(orig) if orig.status().is_success() => {
                        ("originals", None, "仅解锁自制剧".to_owned())
                    }
                    _ => ("blocked", None, "地区受限".to_owned()),
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "Disney+" => match get("https://www.disneyplus.com/").await {
            Ok(resp) => {
                let final_url = resp.url().as_str().to_owned();
                if resp.status().is_success() && !final_url.contains("unavailable") {
                    ("available", None, "可正常打开".to_owned())
                } else {
                    ("blocked", None, "地区不可用或受限".to_owned())
                }
            }
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "YouTube Premium" => match get("https://www.youtube.com/premium").await {
            Ok(resp) if resp.status().is_success() => {
                let body = resp.text().await.unwrap_or_default();
                if body.contains("Premium is not available in your country") {
                    ("blocked", None, "所在地区不支持 Premium".to_owned())
                } else {
                    ("available", None, "支持访问 Premium".to_owned())
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "Spotify" => match get("https://open.spotify.com/").await {
            Ok(resp) if resp.status().is_success() => ("available", None, "可正常访问".to_owned()),
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "TikTok" => match get("https://www.tiktok.com/").await {
            Ok(resp) if resp.status().is_success() => {
                let body = resp.text().await.unwrap_or_default();
                if body.contains("not available in your region") {
                    ("blocked", None, "所在地区不可用".to_owned())
                } else {
                    ("available", None, "网页可访问".to_owned())
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "Prime Video" => match get("https://www.primevideo.com/").await {
            Ok(resp) if resp.status().is_success() => ("available", None, "页面可访问".to_owned()),
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        "哔哩哔哩大陆" => {
            match get("https://api.bilibili.com/pgc/player/web/playurl?avid=82846771&cid=141738666&qn=0&type=&otype=json&ep_id=300998&fourk=1&fnver=0&fnval=16&module=bangumi").await {
                Ok(resp) if resp.status().is_success() => {
                    let bytes = resp.bytes().await.unwrap_or_default();
                    let json: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                    if json.get("code").and_then(Value::as_i64) == Some(0) {
                        ("available", Some("CN".to_owned()), "可播放大陆限定番剧".to_owned())
                    } else {
                        ("blocked", None, "仅限大陆地区".to_owned())
                    }
                }
                Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
                Err(_) => ("error", None, "请求失败或超时".to_owned()),
            }
        }
        "哔哩哔哩港澳台" => {
            match get("https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=183799&fourk=1&fnver=0&fnval=16&module=bangumi").await {
                Ok(resp) if resp.status().is_success() => {
                    let bytes = resp.bytes().await.unwrap_or_default();
                    let json: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                    if json.get("code").and_then(Value::as_i64) == Some(0) {
                        ("available", Some("HK/TW".to_owned()), "可播放港澳台限定番剧".to_owned())
                    } else {
                        ("blocked", None, "仅限港澳台地区".to_owned())
                    }
                }
                Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
                Err(_) => ("error", None, "请求失败或超时".to_owned()),
            }
        }
        "Bahamut Anime" => match get("https://ani.gamer.com.tw/ajax/token.php?adID=89422&sn=14667").await {
            Ok(resp) if resp.status().is_success() => {
                let bytes = resp.bytes().await.unwrap_or_default();
                let json: Value = serde_json::from_slice(&bytes).unwrap_or_default();
                if json.get("animeSn").is_some() {
                    ("available", Some("TW".to_owned()), "解锁动画疯".to_owned())
                } else {
                    ("blocked", None, "仅限台湾地区".to_owned())
                }
            }
            Ok(resp) => ("blocked", None, format!("HTTP {}", resp.status().as_u16())),
            Err(_) => ("error", None, "请求失败或超时".to_owned()),
        },
        _ => return Err("不支持的服务检测项".into()),
    };
    Ok(UnlockResult {
        service: service.to_owned(),
        status,
        region,
        detail,
        milliseconds: started.elapsed().as_millis() as u64,
    })
}

pub async fn measure_download(port: u16) -> Result<DownloadMeasurement, String> {
    let _permit = DOWNLOAD_SLOT
        .try_acquire()
        .map_err(|_| "已有下载测速正在运行")?;
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "无法启动下载测速")?;
    let url = format!("https://speed.cloudflare.com/__down?bytes={DOWNLOAD_LIMIT}");
    download_sample(&client, &url, DOWNLOAD_LIMIT).await
}

async fn download_sample(
    client: &reqwest::Client,
    url: &str,
    expected: u64,
) -> Result<DownloadMeasurement, String> {
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| "测速服务连接失败或超时")?;
    let binary = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next() == Some("application/octet-stream"));
    if response.status() != reqwest::StatusCode::OK
        || !binary
        || response.content_length() != Some(expected)
    {
        return Err("测速服务未返回预期的测试数据".into());
    }

    let start = tokio::time::Instant::now();
    let deadline = start + Duration::from_secs(12);
    let mut bytes = 0;
    while bytes < expected {
        match tokio::time::timeout_at(deadline, response.chunk()).await {
            Ok(Ok(Some(chunk))) => bytes += chunk.len() as u64,
            Err(_) if bytes >= 128 * 1024 => break,
            _ => return Err("测速数据传输中断或可用样本不足".into()),
        }
    }
    let elapsed = start.elapsed();
    Ok(DownloadMeasurement {
        bytes,
        milliseconds: elapsed.as_millis().max(1) as u64,
        megabits_per_second: bytes as f64 * 8.0 / elapsed.as_secs_f64().max(0.001) / 1_000_000.0,
    })
}

#[derive(Default)]
pub struct ProbeBatch(Mutex<Option<(uuid::Uuid, watch::Sender<()>)>>);

impl ProbeBatch {
    fn begin(&self) -> Result<uuid::Uuid, String> {
        let id = uuid::Uuid::new_v4();
        let (sender, _) = watch::channel(());
        *self.0.lock().map_err(|_| "测速状态不可用")? = Some((id, sender));
        Ok(id)
    }

    fn receive(&self, id: uuid::Uuid) -> Result<watch::Receiver<()>, String> {
        self.0
            .lock()
            .map_err(|_| "测速状态不可用")?
            .as_ref()
            .filter(|(batch, _)| *batch == id)
            .map(|(_, sender)| sender.subscribe())
            .ok_or_else(|| "已取消".into())
    }

    fn cancel(&self, id: uuid::Uuid) -> Result<(), String> {
        let mut active = self.0.lock().map_err(|_| "测速状态不可用")?;
        if active.as_ref().is_some_and(|(batch, _)| *batch == id) {
            active.take();
        }
        Ok(())
    }
}

#[tauri::command]
pub fn begin_probe_batch(state: tauri::State<'_, ProbeBatch>) -> Result<uuid::Uuid, String> {
    state.begin()
}

#[tauri::command]
pub fn cancel_probe_batch(
    batch: uuid::Uuid,
    state: tauri::State<'_, ProbeBatch>,
) -> Result<(), String> {
    state.cancel(batch)
}

async fn launch(core: &Path, action: &str, content: &[u8]) -> Result<Child, String> {
    let mut command = crate::core_command(core);
    command
        .args([action, "-c", "stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动测速内核")?;
    child
        .stdin
        .take()
        .ok_or("无法打开配置管道")?
        .write_all(content)
        .await
        .map_err(|_| "无法交付测速配置")?;
    Ok(child)
}

async fn measure(core: &Path, config: Value, port: u16, probe_url: &str) -> Result<u64, String> {
    let inbound = config
        .get("inbounds")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .ok_or("缺少本地入口")?;
    if inbound.get("listen").and_then(Value::as_str) != Some("127.0.0.1")
        || inbound.get("type").and_then(Value::as_str) != Some("mixed")
        || inbound.get("listen_port").and_then(Value::as_u64) != Some(u64::from(port))
    {
        return Err("测速入口配置无效".into());
    }
    let content = serde_json::to_vec(&config).map_err(|_| "配置无效")?;
    let accepted = tokio::time::timeout(Duration::from_secs(5), async {
        let mut check = launch(core, "check", &content).await?;
        Ok::<_, String>(
            check
                .wait()
                .await
                .map_err(|_| "无法完成配置检查")?
                .success(),
        )
    })
    .await
    .map_err(|_| "测速配置检查超时")??;
    if !accepted {
        return Err("节点配置未通过内核检查".into());
    }

    let mut process = launch(core, "run", &content).await?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if process
                .try_wait()
                .map_err(|_| "无法检查测速内核")?
                .is_some()
            {
                return Err("测速内核启动失败");
            }
            if tokio::time::timeout(
                Duration::from_millis(100),
                tokio::net::TcpStream::connect(address),
            )
            .await
            .is_ok_and(|result| result.is_ok())
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    })
    .await
    .map_err(|_| "测速内核启动超时")??;

    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "代理地址无效")?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化测速")?;
    let started = std::time::Instant::now();
    let response = client
        .get(probe_url)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "请求超时"
            } else if error.is_connect() {
                "建立代理连接或 TLS 握手失败"
            } else {
                "代理请求失败"
            }
        })?;
    if !response.status().is_success() && response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("测速服务返回异常".into());
    }
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn probe_node(
    config: Value,
    port: u16,
    batch: uuid::Uuid,
    probe_url: Option<String>,
    state: tauri::State<'_, ProbeBatch>,
) -> Result<u64, String> {
    let core = crate::core_path()?;
    let url = probe_url
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .unwrap_or("https://www.gstatic.com/generate_204");
    cancellable_measure(&core, config, port, url, state.receive(batch)?).await
}

async fn cancellable_measure(
    core: &Path,
    config: Value,
    port: u16,
    probe_url: &str,
    mut cancel: watch::Receiver<()>,
) -> Result<u64, String> {
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("已取消".into()),
        result = measure(core, config, port, probe_url) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn download_throughput_requires_a_real_binary_sample() {
        use tokio::io::AsyncReadExt;
        for content_type in ["application/octet-stream", "text/html"] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let fixture = tokio::spawn(async move {
                let (mut connection, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(connection.read_u8().await.unwrap());
                }
                let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: 4096\r\nConnection: close\r\n\r\n");
                connection.write_all(reply.as_bytes()).await.unwrap();
                tokio::time::sleep(Duration::from_millis(10)).await;
                let _ = connection.write_all(&[0; 4096]).await;
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let result = download_sample(&client, &format!("http://{address}/"), 4096).await;
            fixture.await.unwrap();
            if content_type == "application/octet-stream" {
                let sample = result.unwrap();
                assert_eq!(sample.bytes, 4096);
                assert!(sample.megabits_per_second.is_finite() && sample.megabits_per_second > 0.0);
            } else {
                assert!(result.is_err());
            }
        }
    }

    #[test]
    fn cancellation_stops_active_and_late_probes_without_touching_the_next_run() {
        let state = ProbeBatch::default();
        let old = state.begin().unwrap();
        let receiver = state.receive(old).unwrap();
        let new = state.begin().unwrap();
        state.cancel(old).unwrap();
        assert!(receiver.has_changed().is_err());
        assert!(state.receive(old).is_err());
        let receiver = state.receive(new).unwrap();
        state.cancel(new).unwrap();
        assert!(receiver.has_changed().is_err());
        assert!(state.receive(new).is_err());
    }

    #[tokio::test]
    async fn cancellation_reclaims_a_real_probe_listener_before_the_upstream_times_out() {
        let Some(core) = std::env::var_os("SING_BOX").map(std::path::PathBuf::from) else {
            return;
        };
        let delayed_upstream = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let upstream_port = delayed_upstream.local_addr().unwrap().port();
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let state = ProbeBatch::default();
        let batch = state.begin().unwrap();
        let cancel = state.receive(batch).unwrap();
        let config = serde_json::json!({
            "inbounds":[{"type":"mixed","listen":"127.0.0.1","listen_port":port}],
            "outbounds":[{"type":"http","tag":"proxy","server":"127.0.0.1","server_port":upstream_port}],
            "route":{"final":"proxy"}
        });
        let worker = tokio::spawn(async move {
            cancellable_measure(
                &core,
                config,
                port,
                "https://www.gstatic.com/generate_204",
                cancel,
            )
            .await
        });
        let (_unfinished, _) =
            tokio::time::timeout(Duration::from_secs(8), delayed_upstream.accept())
                .await
                .unwrap()
                .unwrap();
        state.cancel(batch).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err(), "已取消");
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("cancelled probe still accepts local connections");
    }
}
