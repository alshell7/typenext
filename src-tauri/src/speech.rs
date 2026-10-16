//! Managed Fluid Speech Mini runtime: a pinned parakeet.cpp build and the
//! FluidVoice GGUF, downloaded only on an explicit writer action, verified with
//! SHA-256 and served by `parakeet-server` on a private loopback port.

use crate::runtime_common::{
    hugging_face_auth, ArchiveKind, Asset, Core, Inner, Job, LaunchSpec, Layout, Progress,
    RuntimeAsset, RuntimeSpec, RuntimeState, MODELS_DIR,
};
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub const STATUS_EVENT: &str = "speech-runtime-status";
const RUNTIME_BASE_URL: &str = "https://github.com/mudler/parakeet.cpp/releases/download/v0.6.1/";
const MODEL_BASE_URL: &str = "https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-gguf/resolve/490bcd5de891f5efd0e732434dfb0a4b0899aead/";
#[cfg(target_os = "windows")]
const SERVER_BINARY: &str = "parakeet-server.exe";
#[cfg(not(target_os = "windows"))]
const SERVER_BINARY: &str = "parakeet-server";
const MAX_THREADS: usize = 4;
const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSCRIPTIONS: usize = 2;
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_ID_HEADER: &str = "x-typenext-request-id";
const TRANSCRIBE_MODEL: &str = "fluid-speech-mini";
const MULTIPART_BOUNDARY: &str = "typenext-speech-7f3c9d2a41b84e6f";
const TRANSCRIBE_CANCELLED: &str = "Transcription cancelled";
const NOT_INSTALLED: &str = "Fluid Speech Mini is not installed.";

static LAYOUT: Layout = Layout {
    release: "v0.6.1",
    runtime_dir: "runtime-v0.6.1",
    binary: SERVER_BINARY,
    pidfile: "parakeet-server.pid",
    server: "speech server",
    runtime: "Fluid Speech Mini runtime",
    clear_env: &["PARAKEET_"],
};

const MODEL: Asset = Asset {
    file: "fluid-speech-mini-q2k-q4k.gguf",
    bytes: 347_357_184,
    sha256: "f0796bf40274cc49d3db58563c23cd024b52ca7e2ae4749ccf27af85841726b5",
};

fn runtime_asset_for(os: &str, arch: &str) -> Option<RuntimeAsset> {
    let (file, bytes, sha256, kind) = match (os, arch) {
        ("macos", "aarch64") => (
            "parakeet-v0.6.1-bin-macos-metal-arm64.tar.gz",
            2_587_801,
            "bc97b5e6253e928d1127f48f08242324317495ef8708e31db1e09b9537d1bb74",
            ArchiveKind::TarGz,
        ),
        ("macos", "x86_64") => (
            "parakeet-v0.6.1-bin-macos-cpu-x64.tar.gz",
            2_753_061,
            "82392069ea091c896dcf86fb5d86f20d107c71f6bad4b9e79a114523d98fb643",
            ArchiveKind::TarGz,
        ),
        ("linux", "x86_64") => (
            "parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz",
            2_727_511,
            "cce60d122ab72e1068cd0d164e54a21655a0b83f1b9c21befc20124f5a972c10",
            ArchiveKind::TarGz,
        ),
        ("linux", "aarch64") => (
            "parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz",
            2_448_702,
            "85b6dafce8a984d0971d94865da5e2e50e111604fb6e7030f5b599dc2616c8db",
            ArchiveKind::TarGz,
        ),
        ("windows", "x86_64") => (
            "parakeet-v0.6.1-bin-win-cpu-x64.zip",
            1_789_301,
            "d74b4e857f75f91ae215c5e91ec42bf15ec84ed3a369423c134dbd6422243ed8",
            ArchiveKind::Zip,
        ),
        // parakeet.cpp v0.6.1 publishes no Windows on Arm build.
        _ => return None,
    };
    Some(RuntimeAsset {
        asset: Asset {
            file,
            bytes,
            sha256,
        },
        kind,
    })
}

fn runtime_asset() -> Option<RuntimeAsset> {
    runtime_asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    runtime: bool,
    model: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInfo {
    endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRuntimeStatus {
    state: RuntimeState,
    installed: Installed,
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<RunningInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
    disk_bytes: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    #[serde(default)]
    hf_token: Option<String>,
}

/// Counts distinct (package, core) pairs in /proc/cpuinfo. Arm kernels omit
/// these fields; their cores have no SMT siblings, so `None` falls back to the
/// logical count.
#[cfg(any(target_os = "linux", test))]
fn physical_cores_from_cpuinfo(cpuinfo: &str) -> Option<usize> {
    let mut cores = std::collections::HashSet::new();
    let mut package = None;
    for line in cpuinfo.lines() {
        let Some((key, value)) = line.split_once(':') else {
            package = None;
            continue;
        };
        match key.trim() {
            "physical id" => package = Some(value.trim().to_string()),
            "core id" => {
                cores.insert((package.clone(), value.trim().to_string()));
            }
            _ => {}
        }
    }
    (!cores.is_empty()).then_some(cores.len())
}

fn physical_cores() -> Option<usize> {
    #[cfg(target_os = "macos")]
    {
        let mut cores: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: the name is NUL-terminated and the output buffer is an int
        // whose size is passed alongside it.
        let result = unsafe {
            libc::sysctlbyname(
                c"hw.physicalcpu".as_ptr(),
                (&mut cores as *mut libc::c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (result == 0 && cores > 0).then_some(cores as usize)
    }
    #[cfg(target_os = "linux")]
    {
        physical_cores_from_cpuinfo(&std::fs::read_to_string("/proc/cpuinfo").ok()?)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

/// parakeet.cpp's guidance: threads should not exceed the physical cores.
fn thread_count(physical: Option<usize>) -> usize {
    physical
        .or_else(|| std::thread::available_parallelism().ok().map(usize::from))
        .unwrap_or(1)
        .clamp(1, MAX_THREADS)
}

fn server_args(model: &Path, port: u16, threads: usize) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--model".into(), model.into()];
    args.extend(
        [
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            port.to_string(),
            "--threads".to_string(),
            threads.to_string(),
        ]
        .map(OsString::from),
    );
    args
}

fn installed(inner: &Inner<RunningInfo>) -> Installed {
    Installed {
        runtime: inner.server_binary.is_some(),
        model: inner.has_model(MODEL.file),
    }
}

fn plan_jobs(root: &Path, runtime: RuntimeAsset, installed: &Installed) -> Vec<Job> {
    let mut jobs = Vec::new();
    if !installed.runtime {
        jobs.push(Job::runtime(root, RUNTIME_BASE_URL, runtime));
    }
    if !installed.model {
        jobs.push(Job::model(root, MODEL_BASE_URL, MODEL));
    }
    jobs
}

pub struct SpeechSpec;

impl RuntimeSpec for SpeechSpec {
    type Running = RunningInfo;
    type Status = SpeechRuntimeStatus;

    fn snapshot(inner: &Inner<RunningInfo>, supported: bool) -> SpeechRuntimeStatus {
        SpeechRuntimeStatus {
            state: inner.state(supported),
            installed: installed(inner),
            running: inner.running().cloned(),
            progress: inner.progress.clone(),
            error: inner.error.clone(),
            error_code: inner.error_code,
            disk_bytes: inner.disk_bytes,
        }
    }
}

/// Audio must be a RIFF/WAVE file the server can decode.
fn validate_wav(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("The recording is larger than 64 MB. Dictate a shorter passage.".into());
    }
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("The recording is not a WAV file".into());
    }
    Ok(())
}

/// The optional `x-typenext-request-id` header names a relay that
/// `speech_runtime_cancel_transcribe` can cancel.
fn parse_request_id(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(id) = value else {
        return Ok(None);
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The transcription request identifier is invalid".into());
    }
    Ok(Some(id.to_string()))
}

fn multipart_body(audio: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in [
        ("model", TRANSCRIBE_MODEL),
        ("response_format", "verbose_json"),
    ] {
        body.extend_from_slice(
            format!(
                "--{MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{MULTIPART_BOUNDARY}--\r\n").as_bytes());
    body
}

/// Sends one multipart transcription to the loopback server.
async fn post_transcription(
    endpoint: &str,
    body: Vec<u8>,
    token: &CancellationToken,
) -> Result<serde_json::Value, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(TRANSCRIBE_TIMEOUT)
        .build()
        .map_err(|_| "Could not prepare the transcription request".to_string())?;
    let request = client
        .post(format!("{endpoint}/v1/audio/transcriptions"))
        .header(
            CONTENT_TYPE,
            format!("multipart/form-data; boundary={MULTIPART_BOUNDARY}"),
        )
        .body(body);
    // Dropping the request future closes the connection when cancelled.
    let exchange = async {
        let response = request.send().await?;
        let status = response.status();
        Ok::<_, reqwest::Error>((status, response.bytes().await?))
    };
    let (status, bytes) = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(TRANSCRIBE_CANCELLED.into()),
        exchange = exchange => exchange.map_err(|error| {
            if error.is_timeout() {
                "Fluid Speech Mini took longer than 120 seconds to transcribe".to_string()
            } else {
                "Could not reach the speech server".to_string()
            }
        })?,
    };
    if status != StatusCode::OK {
        let text = String::from_utf8_lossy(&bytes);
        let short: String = text.trim().chars().take(200).collect();
        return Err(format!("HTTP {}: {short}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "The speech server did not return JSON".to_string())
}

#[derive(Default)]
struct RelayRegistry {
    active: HashMap<String, CancellationToken>,
    // Handles cancellation racing ahead of the relay's IPC dispatch.
    cancelled: HashMap<String, Instant>,
}

struct RelayGuard {
    id: Option<String>,
    registry: Arc<Mutex<RelayRegistry>>,
}

impl Drop for RelayGuard {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            self.registry
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .active
                .remove(id);
        }
    }
}

fn begin_relay(
    registry: &Arc<Mutex<RelayRegistry>>,
    id: Option<String>,
) -> Result<(CancellationToken, RelayGuard), String> {
    let token = CancellationToken::new();
    if let Some(id) = &id {
        let mut relays = registry.lock().unwrap_or_else(PoisonError::into_inner);
        relays
            .cancelled
            .retain(|_, at| at.elapsed() < Duration::from_secs(60));
        if relays.cancelled.remove(id).is_some() {
            return Err(TRANSCRIBE_CANCELLED.into());
        }
        if relays.active.contains_key(id) {
            return Err("This transcription identifier is already in use".into());
        }
        relays.active.insert(id.clone(), token.clone());
    }
    Ok((
        token,
        RelayGuard {
            id,
            registry: registry.clone(),
        },
    ))
}

fn cancel_relay(registry: &Mutex<RelayRegistry>, id: &str) {
    let mut relays = registry.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(token) = relays.active.get(id) {
        token.cancel();
        return;
    }
    relays
        .cancelled
        .retain(|_, at| at.elapsed() < Duration::from_secs(60));
    if relays.cancelled.len() >= 256 {
        if let Some(oldest) = relays
            .cancelled
            .iter()
            .min_by_key(|(_, at)| *at)
            .map(|(id, _)| id.clone())
        {
            relays.cancelled.remove(&oldest);
        }
    }
    relays.cancelled.insert(id.to_string(), Instant::now());
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelTranscribeRequest {
    request_id: String,
}

pub struct SpeechState {
    core: Core<SpeechSpec>,
    relays: Arc<Mutex<RelayRegistry>>,
    slots: Semaphore,
}

impl SpeechState {
    pub fn new(root: PathBuf, emit: impl Fn(&SpeechRuntimeStatus) + Send + Sync + 'static) -> Self {
        Self {
            core: Core::new(root, &LAYOUT, runtime_asset(), vec![MODEL], emit),
            relays: Arc::default(),
            slots: Semaphore::new(MAX_TRANSCRIPTIONS),
        }
    }

    /// Kills the server synchronously. Called when the app exits.
    pub fn shutdown(&self) {
        self.core.shutdown();
    }

    pub async fn status(&self) -> Result<SpeechRuntimeStatus, String> {
        self.core.status().await
    }

    pub fn cancel(&self) {
        self.core.cancel();
    }

    pub async fn install(&self, request: InstallRequest) -> Result<SpeechRuntimeStatus, String> {
        let auth = hugging_face_auth(request.hf_token.as_deref())?;
        let root = self.core.root().to_path_buf();
        self.core
            .install(auth, move |inner, runtime| {
                plan_jobs(&root, runtime, &installed(inner))
            })
            .await
    }

    /// parakeet-server has no API key option; it listens only on loopback at
    /// a random port for the length of a dictation session.
    pub async fn start(&self) -> Result<SpeechRuntimeStatus, String> {
        let model = self.core.root().join(MODELS_DIR).join(MODEL.file);
        let threads = thread_count(physical_cores());
        self.core
            .start(
                |_| true,
                |inner| {
                    (!inner.has_model(MODEL.file))
                        .then(|| "Download Fluid Speech Mini before dictating".into())
                },
                |port| {
                    Ok(LaunchSpec {
                        args: server_args(&model, port, threads),
                        env: Vec::new(),
                        secret: None,
                        running: RunningInfo {
                            endpoint: format!("http://127.0.0.1:{port}"),
                        },
                    })
                },
            )
            .await
    }

    pub async fn stop(&self) -> SpeechRuntimeStatus {
        self.core.stop().await
    }

    /// Relays one WAV recording to the local server, starting it if needed.
    /// parakeet-server sends no CORS headers, so the webview cannot call it.
    pub async fn transcribe(
        &self,
        audio: &[u8],
        request_id: Option<String>,
    ) -> Result<serde_json::Value, String> {
        validate_wav(audio)?;
        let (token, _guard) = begin_relay(&self.relays, request_id)?;
        let Ok(_slot) = self.slots.try_acquire() else {
            return Err("Fluid Speech Mini is already transcribing two recordings".into());
        };
        let body = multipart_body(audio);
        let endpoint = match self.core.snapshot().running {
            Some(running) => running.endpoint,
            None => {
                let status = self.status().await?;
                if !status.installed.runtime || !status.installed.model {
                    return Err(NOT_INSTALLED.into());
                }
                let status = tokio::select! {
                    biased;
                    _ = token.cancelled() => return Err(TRANSCRIBE_CANCELLED.into()),
                    status = self.start() => status?,
                };
                status
                    .running
                    .map(|running| running.endpoint)
                    .ok_or("Fluid Speech Mini did not start")?
            }
        };
        post_transcription(&endpoint, body, &token).await
    }

    pub fn cancel_transcribe(&self, request_id: &str) -> Result<(), String> {
        let id = parse_request_id(Some(request_id))?.unwrap_or_default();
        cancel_relay(&self.relays, &id);
        Ok(())
    }

    pub async fn remove(&self) -> Result<SpeechRuntimeStatus, String> {
        self.core.remove().await
    }
}

#[tauri::command]
pub async fn speech_runtime_status(
    state: State<'_, SpeechState>,
) -> Result<SpeechRuntimeStatus, String> {
    state.status().await
}

#[tauri::command]
pub async fn speech_runtime_install(
    state: State<'_, SpeechState>,
    request: Option<InstallRequest>,
) -> Result<SpeechRuntimeStatus, String> {
    state.install(request.unwrap_or_default()).await
}

#[tauri::command]
pub fn speech_runtime_cancel(state: State<'_, SpeechState>) {
    state.cancel();
}

#[tauri::command]
pub async fn speech_runtime_start(
    state: State<'_, SpeechState>,
) -> Result<SpeechRuntimeStatus, String> {
    state.start().await
}

#[tauri::command]
pub async fn speech_runtime_stop(
    state: State<'_, SpeechState>,
) -> Result<SpeechRuntimeStatus, String> {
    Ok(state.stop().await)
}

/// Invoked as `invoke('speech_runtime_transcribe', wavBytes, { headers:
/// { 'x-typenext-request-id': id } })` with a raw `Uint8Array` body.
#[tauri::command]
pub async fn speech_runtime_transcribe(
    state: State<'_, SpeechState>,
    request: Request<'_>,
) -> Result<serde_json::Value, String> {
    let InvokeBody::Raw(audio) = request.body() else {
        return Err("Send the recording as raw WAV bytes".into());
    };
    let request_id = parse_request_id(
        request
            .headers()
            .get(REQUEST_ID_HEADER)
            .map(|value| {
                value
                    .to_str()
                    .map_err(|_| "The transcription request identifier is invalid")
            })
            .transpose()?,
    )?;
    state.transcribe(audio, request_id).await
}

#[tauri::command]
pub fn speech_runtime_cancel_transcribe(
    state: State<'_, SpeechState>,
    request: CancelTranscribeRequest,
) -> Result<(), String> {
    state.cancel_transcribe(&request.request_id)
}

#[tauri::command]
pub async fn speech_runtime_remove(
    state: State<'_, SpeechState>,
) -> Result<SpeechRuntimeStatus, String> {
    state.remove().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_common::{
        install_runtime_archive, normalize, process_path, read_pidfile, verify_file, VerifyCache,
        DOWNLOADS_DIR,
    };
    use reqwest::Client;
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[test]
    fn manifest_pins_every_published_parakeet_build() {
        let cases = [
            (
                "macos",
                "aarch64",
                "parakeet-v0.6.1-bin-macos-metal-arm64.tar.gz",
                2_587_801,
            ),
            (
                "macos",
                "x86_64",
                "parakeet-v0.6.1-bin-macos-cpu-x64.tar.gz",
                2_753_061,
            ),
            (
                "linux",
                "x86_64",
                "parakeet-v0.6.1-bin-linux-cpu-x64.tar.gz",
                2_727_511,
            ),
            (
                "linux",
                "aarch64",
                "parakeet-v0.6.1-bin-linux-cpu-arm64.tar.gz",
                2_448_702,
            ),
            (
                "windows",
                "x86_64",
                "parakeet-v0.6.1-bin-win-cpu-x64.zip",
                1_789_301,
            ),
        ];
        for (os, arch, file, bytes) in cases {
            let runtime = runtime_asset_for(os, arch).unwrap();
            assert_eq!((runtime.asset.file, runtime.asset.bytes), (file, bytes));
            assert_eq!(
                runtime.kind,
                if os == "windows" {
                    ArchiveKind::Zip
                } else {
                    ArchiveKind::TarGz
                }
            );
            assert_eq!(runtime.asset.sha256.len(), 64);
        }
        assert!(runtime_asset_for("windows", "aarch64").is_none());
        assert!(runtime_asset_for("linux", "riscv64").is_none());
        assert_eq!(MODEL.sha256.len(), 64);
    }

    #[test]
    fn install_plan_fetches_the_runtime_from_github_and_the_model_from_hugging_face() {
        let root = Path::new("/data/speech");
        let runtime = runtime_asset_for("macos", "aarch64").unwrap();
        let jobs = plan_jobs(root, runtime, &Installed::default());
        assert_eq!(jobs.len(), 2);
        assert_eq!(
            jobs[0].url,
            "https://github.com/mudler/parakeet.cpp/releases/download/v0.6.1/parakeet-v0.6.1-bin-macos-metal-arm64.tar.gz"
        );
        assert!(!jobs[0].hugging_face);
        assert_eq!(
            jobs[1].url,
            "https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-gguf/resolve/490bcd5de891f5efd0e732434dfb0a4b0899aead/fluid-speech-mini-q2k-q4k.gguf"
        );
        assert!(jobs[1].hugging_face);
        assert_eq!(
            jobs[1].destination,
            root.join("models").join("fluid-speech-mini-q2k-q4k.gguf")
        );
        let installed = Installed {
            runtime: true,
            model: true,
        };
        assert!(plan_jobs(root, runtime, &installed).is_empty());
        let request: InstallRequest = serde_json::from_str(r#"{"hfToken":null}"#).unwrap();
        assert!(request.hf_token.is_none());
    }

    #[test]
    fn threads_follow_physical_cores_within_one_to_four() {
        assert_eq!(thread_count(Some(1)), 1);
        assert_eq!(thread_count(Some(2)), 2);
        assert_eq!(thread_count(Some(8)), 4);
        assert_eq!(thread_count(Some(0)), 1);
        assert!((1..=4).contains(&thread_count(None)));
        assert!((1..=4).contains(&thread_count(physical_cores())));
        let cpuinfo = "processor\t: 0\nphysical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 1\nphysical id\t: 0\ncore id\t\t: 0\n\nprocessor\t: 2\nphysical id\t: 0\ncore id\t\t: 1\n\nprocessor\t: 3\nphysical id\t: 1\ncore id\t\t: 0\n";
        assert_eq!(physical_cores_from_cpuinfo(cpuinfo), Some(3));
        assert_eq!(
            physical_cores_from_cpuinfo("processor\t: 0\nBogoMIPS\t: 48.00\n"),
            None
        );
    }

    #[test]
    fn server_arguments_bind_loopback_with_bounded_threads() {
        let args: Vec<String> = server_args(Path::new("/m/fluid.gguf"), 53125, 4)
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
        assert_eq!(
            args.join(" "),
            "--model /m/fluid.gguf --host 127.0.0.1 --port 53125 --threads 4"
        );
    }

    #[test]
    fn status_serializes_with_the_frontend_field_names() {
        let mut inner = Inner::<RunningInfo>::default();
        inner.server_binary = Some(PathBuf::from("/bin/parakeet-server"));
        inner.models = vec![MODEL.file];
        inner.disk_bytes = 9;
        inner.error = Some("Hugging Face is limiting anonymous downloads.".into());
        inner.error_code = Some("huggingface-rate-limit");
        let json = serde_json::to_value(SpeechSpec::snapshot(&inner, true)).unwrap();
        assert_eq!(json["state"], "error");
        assert_eq!(
            json["installed"],
            serde_json::json!({"runtime": true, "model": true})
        );
        assert_eq!(json["errorCode"], "huggingface-rate-limit");
        assert_eq!(json["diskBytes"], 9);
        assert!(json.get("running").is_none() && json.get("progress").is_none());
        let json = serde_json::to_value(SpeechSpec::snapshot(&Inner::default(), false)).unwrap();
        assert_eq!(json["state"], "unsupported");
        assert_eq!(
            json["installed"],
            serde_json::json!({"runtime": false, "model": false})
        );
        assert!(json.get("errorCode").is_none());
        let json = serde_json::to_value(RunningInfo {
            endpoint: "http://127.0.0.1:1".into(),
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({"endpoint": "http://127.0.0.1:1"}));
    }

    fn wav(samples: usize) -> Vec<u8> {
        let data = samples as u32 * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 0, 1, 0]);
        bytes.extend_from_slice(&16_000u32.to_le_bytes());
        bytes.extend_from_slice(&32_000u32.to_le_bytes());
        bytes.extend_from_slice(&[2, 0, 16, 0]);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data.to_le_bytes());
        bytes.resize(44 + data as usize, 0);
        bytes
    }

    #[test]
    fn only_bounded_riff_wave_audio_is_relayed() {
        assert!(validate_wav(&wav(16)).is_ok());
        assert!(validate_wav(&wav(0)).is_ok());
        assert!(validate_wav(b"RIFF").is_err());
        let mut mp3 = wav(16);
        mp3[..4].copy_from_slice(b"ID3\x04");
        assert!(validate_wav(&mp3).is_err());
        let mut avi = wav(16);
        avi[8..12].copy_from_slice(b"AVI ");
        assert!(validate_wav(&avi).is_err());
        let mut large = wav(0);
        large.resize(MAX_AUDIO_BYTES + 1, 0);
        assert!(validate_wav(&large).unwrap_err().contains("64 MB"));
    }

    #[test]
    fn request_ids_are_optional_and_plain() {
        assert_eq!(parse_request_id(None).unwrap(), None);
        assert_eq!(
            parse_request_id(Some("phrase-12_ab")).unwrap().as_deref(),
            Some("phrase-12_ab")
        );
        for invalid in ["", "has space", "../x", "id\n", &"a".repeat(129)] {
            assert!(parse_request_id(Some(invalid)).is_err(), "{invalid:?}");
        }
    }

    #[test]
    fn cancellation_reaches_active_and_not_yet_dispatched_relays() {
        let registry = Arc::new(Mutex::new(RelayRegistry::default()));
        let (token, guard) = begin_relay(&registry, Some("phrase-1".into())).unwrap();
        assert!(begin_relay(&registry, Some("phrase-1".into())).is_err());
        cancel_relay(&registry, "phrase-1");
        assert!(token.is_cancelled());
        drop(guard);
        assert!(registry.lock().unwrap().active.is_empty());
        // A cancel that arrives before the relay starts is not lost.
        cancel_relay(&registry, "phrase-2");
        assert_eq!(
            begin_relay(&registry, Some("phrase-2".into()))
                .err()
                .unwrap(),
            TRANSCRIBE_CANCELLED
        );
        // Relays without an id cannot be cancelled but still run.
        let (token, _guard) = begin_relay(&registry, None).unwrap();
        assert!(!token.is_cancelled());
    }

    /// One HTTP response after reading the whole request, optionally late.
    fn fake_server(
        response: &'static str,
        delay: Duration,
    ) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            stream
                .set_read_timeout(Some(Duration::from_millis(300)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 8192];
            while let Ok(read) = stream.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                if request.ends_with(format!("--{MULTIPART_BOUNDARY}--\r\n").as_bytes()) {
                    break;
                }
            }
            let _ = sender.send(request);
            std::thread::sleep(delay);
            let _ = stream.write_all(response.as_bytes());
        });
        (format!("http://{address}"), receiver)
    }

    #[tokio::test]
    async fn relayed_requests_are_multipart_and_return_the_server_json() {
        let (endpoint, requests) = fake_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 24\r\nConnection: close\r\n\r\n{\"text\":\"Bramble House\"}",
            Duration::ZERO,
        );
        let audio = wav(8);
        let json = post_transcription(&endpoint, multipart_body(&audio), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(json["text"], "Bramble House");
        let request = requests.recv().unwrap();
        let text = String::from_utf8_lossy(&request);
        assert!(text.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
        assert!(text.contains(&format!(
            "multipart/form-data; boundary={MULTIPART_BOUNDARY}"
        )));
        assert!(text.contains("name=\"model\"\r\n\r\nfluid-speech-mini\r\n"));
        assert!(text.contains("name=\"response_format\"\r\n\r\nverbose_json\r\n"));
        assert!(text.contains(
            "name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFF"
        ));
    }

    #[tokio::test]
    async fn server_errors_carry_the_http_status_and_a_short_body() {
        let (endpoint, _requests) = fake_server(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 13\r\nConnection: close\r\n\r\nmodel loading",
            Duration::ZERO,
        );
        let error = post_transcription(
            &endpoint,
            multipart_body(&wav(8)),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "HTTP 503: model loading");
    }

    #[tokio::test]
    async fn cancel_interrupts_an_in_flight_relay() {
        let (endpoint, _requests) = fake_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            Duration::from_secs(5),
        );
        let token = CancellationToken::new();
        let started = Instant::now();
        let (result, ()) = tokio::join!(
            post_transcription(&endpoint, multipart_body(&wav(8)), &token),
            async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                token.cancel();
            }
        );
        assert_eq!(result.unwrap_err(), TRANSCRIBE_CANCELLED);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn transcribing_without_the_model_reports_it_is_not_installed() {
        let directory = tempfile::tempdir().unwrap();
        let state = SpeechState::new(directory.path().join("speech"), |_| {});
        let error = state.transcribe(&wav(8), None).await.unwrap_err();
        if runtime_asset().is_some() {
            assert_eq!(error, NOT_INSTALLED);
        }
        assert!(state.transcribe(b"not audio", None).await.is_err());
    }

    fn link_or_copy(from: &Path, to: &Path) {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        if fs::hard_link(from, to).is_err() {
            fs::copy(from, to).unwrap();
        }
    }

    fn multipart(audio: &[u8]) -> (String, Vec<u8>) {
        let boundary = "typenext-speech-test-boundary";
        let mut body = Vec::new();
        for (name, value) in [
            ("model", "fluid-speech-mini"),
            ("response_format", "verbose_json"),
        ] {
            body.extend(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                    .bytes(),
            );
        }
        body.extend(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
            )
            .bytes(),
        );
        body.extend_from_slice(audio);
        body.extend(format!("\r\n--{boundary}--\r\n").bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    /// Runs the real server from a prepared directory. Point
    /// TYPENEXT_SPEECH_TEST_DIR at a folder holding the pinned parakeet.cpp
    /// archive for this platform (as `pk.tar.gz` or its release name) and the
    /// model as `fluid.gguf`. The audio is TYPENEXT_SPEECH_TEST_WAV, or
    /// `speech.wav` in that folder or its parent.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a local parakeet.cpp build and Fluid Speech Mini weights"]
    async fn managed_speech_server_transcribes_audio() {
        let source = PathBuf::from(
            std::env::var_os("TYPENEXT_SPEECH_TEST_DIR").expect("set TYPENEXT_SPEECH_TEST_DIR"),
        );
        let runtime = runtime_asset().expect("unsupported platform");
        let archive = [runtime.asset.file, "pk.tar.gz", "pk.zip"]
            .into_iter()
            .map(|name| source.join(name))
            .find(|path| path.is_file())
            .expect("the pinned parakeet.cpp archive is missing");
        let audio = std::env::var_os("TYPENEXT_SPEECH_TEST_WAV")
            .map(PathBuf::from)
            .into_iter()
            .chain([source.join("speech.wav"), source.join("../speech.wav")])
            .find(|path| path.is_file())
            .expect("speech.wav is missing");
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("speech");
        let downloads = root.join(DOWNLOADS_DIR).join(runtime.asset.file);
        link_or_copy(&archive, &downloads);
        link_or_copy(
            &source.join("fluid.gguf"),
            &root.join(MODELS_DIR).join(MODEL.file),
        );
        let mut cache = VerifyCache::new();
        assert!(verify_file(
            &mut cache,
            &downloads,
            runtime.asset.bytes,
            runtime.asset.sha256
        ));
        install_runtime_archive(
            &root,
            &LAYOUT,
            &downloads,
            runtime.kind,
            runtime.asset.sha256,
        )
        .unwrap();
        fs::remove_dir_all(root.join(DOWNLOADS_DIR)).unwrap();

        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let state = SpeechState::new(root.clone(), move |status| {
            seen.lock().unwrap().push(status.state)
        });
        let status = state.status().await.unwrap();
        assert_eq!(
            status.installed,
            Installed {
                runtime: true,
                model: true
            }
        );

        let started = Instant::now();
        let status = state.start().await.unwrap();
        println!("speech server ready in {:?}", started.elapsed());
        assert_eq!(status.state, RuntimeState::Running);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [RuntimeState::Starting, RuntimeState::Running]
        );
        let endpoint = status.running.unwrap().endpoint;
        let record = read_pidfile(&root.join(LAYOUT.pidfile)).unwrap();
        assert_eq!(
            process_path(record.pid).map(|path| normalize(&path)),
            Some(record.path.clone())
        );

        let client = Client::new();
        let health = client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .unwrap();
        assert!(health.status().is_success());
        let (content_type, body) = multipart(&fs::read(&audio).unwrap());
        let started = Instant::now();
        let response = client
            .post(format!("{endpoint}/v1/audio/transcriptions"))
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body)
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success(), "{}", response.status());
        let transcript: serde_json::Value = response.json().await.unwrap();
        let text = transcript["text"].as_str().unwrap_or_default();
        println!("transcribed in {:?}: {text}", started.elapsed());
        assert!(text.contains("Bramble House"), "{transcript}");

        // The native relay reaches the same server for the webview.
        let started = Instant::now();
        let relayed = state
            .transcribe(&fs::read(&audio).unwrap(), Some("integration-1".into()))
            .await
            .unwrap();
        let text = relayed["text"].as_str().unwrap_or_default();
        println!("relayed in {:?}: {text}", started.elapsed());
        assert!(text.contains("Bramble House"), "{relayed}");

        // A second start reuses the running server.
        let again = state.start().await.unwrap();
        assert_eq!(again.running.unwrap().endpoint, endpoint);

        let status = state.stop().await;
        assert_eq!(status.state, RuntimeState::Idle);
        assert!(!root.join(LAYOUT.pidfile).exists());
        assert!(client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .is_err());
    }
}
