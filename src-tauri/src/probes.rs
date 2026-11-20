use serde_json::Value;
use std::{net::SocketAddr, path::Path, process::Stdio, sync::Mutex, time::Duration};
use tokio::{io::AsyncWriteExt, process::Child, sync::watch};

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

async fn measure(core: &Path, config: Value, port: u16) -> Result<u64, String> {
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
        .get("https://www.gstatic.com/generate_204")
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
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("测速服务返回异常".into());
    }
    Ok(started.elapsed().as_millis() as u64)
}

#[tauri::command]
pub async fn probe_node(
    config: Value,
    port: u16,
    batch: uuid::Uuid,
    state: tauri::State<'_, ProbeBatch>,
) -> Result<u64, String> {
    let core = crate::core_path()?;
    cancellable_measure(&core, config, port, state.receive(batch)?).await
}

async fn cancellable_measure(
    core: &Path,
    config: Value,
    port: u16,
    mut cancel: watch::Receiver<()>,
) -> Result<u64, String> {
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("已取消".into()),
        result = measure(core, config, port) => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let worker =
            tokio::spawn(async move { cancellable_measure(&core, config, port, cancel).await });
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
