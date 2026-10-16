//! Managed EmbeddingGemma 2 runtime: a pinned llama.cpp build and GGUF weights
//! that are downloaded only on an explicit writer action, verified with SHA-256
//! and served by `llama-server --embeddings` on a private loopback port.

use crate::runtime_common::{
    hugging_face_auth, random_key, ArchiveKind, Asset, Core, Inner, Job, LaunchSpec, Layout,
    Progress, RuntimeAsset, RuntimeSpec, RuntimeState, MODELS_DIR,
};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::State;

pub const STATUS_EVENT: &str = "embedding-runtime-status";
const RUNTIME_BASE_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11696/";
const MODEL_BASE_URL: &str =
    "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/";
const MODEL_ALIAS: &str = "embeddinggemma2";
#[cfg(target_os = "windows")]
const SERVER_BINARY: &str = "llama-server.exe";
#[cfg(not(target_os = "windows"))]
const SERVER_BINARY: &str = "llama-server";
const MIN_CONTEXT: u32 = 512;
const MAX_CONTEXT: u32 = 8192;
const DEFAULT_CONTEXT: u32 = 2048;

static LAYOUT: Layout = Layout {
    release: "b11696",
    runtime_dir: "runtime-b11696",
    binary: SERVER_BINARY,
    pidfile: "llama-server.pid",
    server: "embedding server",
    runtime: "managed embedding runtime",
    clear_env: &["LLAMA_"],
};

fn runtime_asset_for(os: &str, arch: &str) -> Option<RuntimeAsset> {
    let (file, bytes, sha256, kind) = match (os, arch) {
        ("macos", "aarch64") => (
            "llama-b11696-bin-macos-arm64.tar.gz",
            12_222_784,
            "6aac007fbe153efefe06250d2cf05d0487583aa0706379082ebef2b05579f649",
            ArchiveKind::TarGz,
        ),
        ("macos", "x86_64") => (
            "llama-b11696-bin-macos-x64.tar.gz",
            11_704_689,
            "366662e7a501cddcf8c0b743ce081d150edd15869cb7e5b0877fbeb1cbfcc171",
            ArchiveKind::TarGz,
        ),
        ("linux", "x86_64") => (
            "llama-b11696-bin-ubuntu-x64.tar.gz",
            17_883_307,
            "6a04629ca5265eb4c5c7d6edec8d6fa429e7e7da2de1cd5d5e357a492fc8f802",
            ArchiveKind::TarGz,
        ),
        ("linux", "aarch64") => (
            "llama-b11696-bin-ubuntu-arm64.tar.gz",
            13_935_439,
            "2a415c6641e1ba4ba73a6db91479bb88382419e913973ceddac2f63865191202",
            ArchiveKind::TarGz,
        ),
        ("windows", "x86_64") => (
            "llama-b11696-bin-win-cpu-x64.zip",
            19_575_690,
            "1e7c47dff58467540d53e6cf302d83951bcb165afb252c2952ed3872190fc60d",
            ArchiveKind::Zip,
        ),
        ("windows", "aarch64") => (
            "llama-b11696-bin-win-cpu-arm64.zip",
            12_469_399,
            "6a5eed00283fdf2c343b4659018408c9e84f2932cddb133c92a0966146911ca8",
            ArchiveKind::Zip,
        ),
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

const MEDIA: Asset = Asset {
    file: "mmproj-Q8_0.gguf",
    bytes: 554_821_120,
    sha256: "90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Quantization {
    #[serde(rename = "UD-Q4_K_XL")]
    Q4,
    #[serde(rename = "Q8_0")]
    Q8,
}

impl Quantization {
    const ALL: [Self; 2] = [Self::Q4, Self::Q8];

    fn asset(self) -> Asset {
        match self {
            Self::Q4 => Asset {
                file: "embeddinggemma-2-UD-Q4_K_XL.gguf",
                bytes: 175_673_856,
                sha256: "ea905fd08e8061db77a0031cbb5096d459d7cfd2bdd0ad2ba66e483f16719493",
            },
            Self::Q8 => Asset {
                file: "embeddinggemma-2-Q8_0.gguf",
                bytes: 309_855_520,
                sha256: "6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc",
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    runtime: bool,
    models: Vec<Quantization>,
    media: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInfo {
    endpoint: String,
    api_key: String,
    quantization: Quantization,
    media: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRuntimeStatus {
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    quantization: Quantization,
    #[serde(default)]
    media: bool,
    #[serde(default)]
    hf_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    quantization: Quantization,
    #[serde(default)]
    media: bool,
    #[serde(default = "default_context")]
    context_size: u32,
}

fn default_context() -> u32 {
    DEFAULT_CONTEXT
}

/// Embeddings use non-causal pooling, so the context, batch and micro-batch
/// all share this bound: a single input must fit in one micro-batch.
fn clamp_context(size: u32) -> u32 {
    size.clamp(MIN_CONTEXT, MAX_CONTEXT)
}

fn plan_jobs(
    root: &Path,
    runtime: RuntimeAsset,
    installed: &Installed,
    quantization: Quantization,
    media: bool,
) -> Vec<Job> {
    let mut jobs = Vec::new();
    if !installed.runtime {
        jobs.push(Job::runtime(root, RUNTIME_BASE_URL, runtime));
    }
    if !installed.models.contains(&quantization) {
        jobs.push(Job::model(root, MODEL_BASE_URL, quantization.asset()));
    }
    if media && !installed.media {
        jobs.push(Job::model(root, MODEL_BASE_URL, MEDIA));
    }
    jobs
}

fn server_args(model: &Path, mmproj: Option<&Path>, context: u32, port: u16) -> Vec<OsString> {
    let context = context.to_string();
    let port = port.to_string();
    let mut args: Vec<OsString> = vec!["--model".into(), model.into()];
    if let Some(mmproj) = mmproj {
        args.extend(["--mmproj".into(), mmproj.into()]);
    }
    args.extend(
        [
            "--alias",
            MODEL_ALIAS,
            "--embeddings",
            "--pooling",
            "mean",
            "--ctx-size",
            context.as_str(),
            "--batch-size",
            context.as_str(),
            "--ubatch-size",
            context.as_str(),
            "--parallel",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            port.as_str(),
            "--no-webui",
            "--offline",
            "--log-colors",
            "off",
        ]
        .map(OsString::from),
    );
    args
}

fn installed(inner: &Inner<RunningInfo>) -> Installed {
    Installed {
        runtime: inner.server_binary.is_some(),
        models: Quantization::ALL
            .into_iter()
            .filter(|quantization| inner.has_model(quantization.asset().file))
            .collect(),
        media: inner.has_model(MEDIA.file),
    }
}

pub struct EmbeddingSpec;

impl RuntimeSpec for EmbeddingSpec {
    type Running = RunningInfo;
    type Status = EmbeddingRuntimeStatus;

    fn snapshot(inner: &Inner<RunningInfo>, supported: bool) -> EmbeddingRuntimeStatus {
        EmbeddingRuntimeStatus {
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

pub struct EmbeddingState {
    core: Core<EmbeddingSpec>,
}

impl EmbeddingState {
    pub fn new(
        root: PathBuf,
        emit: impl Fn(&EmbeddingRuntimeStatus) + Send + Sync + 'static,
    ) -> Self {
        Self::with_runtime(root, runtime_asset(), emit)
    }

    fn with_runtime(
        root: PathBuf,
        runtime: Option<RuntimeAsset>,
        emit: impl Fn(&EmbeddingRuntimeStatus) + Send + Sync + 'static,
    ) -> Self {
        let models = Quantization::ALL
            .into_iter()
            .map(Quantization::asset)
            .chain([MEDIA])
            .collect();
        Self {
            core: Core::new(root, &LAYOUT, runtime, models, emit),
        }
    }

    /// Kills the server synchronously. Called when the app exits.
    pub fn shutdown(&self) {
        self.core.shutdown();
    }

    pub async fn status(&self) -> Result<EmbeddingRuntimeStatus, String> {
        self.core.status().await
    }

    pub fn cancel(&self) {
        self.core.cancel();
    }

    pub async fn install(&self, request: InstallRequest) -> Result<EmbeddingRuntimeStatus, String> {
        let auth = hugging_face_auth(request.hf_token.as_deref())?;
        let root = self.core.root().to_path_buf();
        self.core
            .install(auth, move |inner, runtime| {
                plan_jobs(
                    &root,
                    runtime,
                    &installed(inner),
                    request.quantization,
                    request.media,
                )
            })
            .await
    }

    pub async fn start(&self, request: StartRequest) -> Result<EmbeddingRuntimeStatus, String> {
        let StartRequest {
            quantization,
            media,
            context_size,
        } = request;
        let context = clamp_context(context_size);
        let models = self.core.root().join(MODELS_DIR);
        let model = models.join(quantization.asset().file);
        let mmproj = media.then(|| models.join(MEDIA.file));
        self.core
            .start(
                |running| running.quantization == quantization && (running.media || !media),
                |inner| {
                    let ready = inner.has_model(quantization.asset().file)
                        && (!media || inner.has_model(MEDIA.file));
                    (!ready).then(|| {
                        "Download the embedding model before starting semantic search".into()
                    })
                },
                |port| {
                    let key = random_key()?;
                    Ok(LaunchSpec {
                        args: server_args(&model, mmproj.as_deref(), context, port),
                        // llama-server reads its key from the environment, which
                        // other local users cannot see in the process list.
                        env: vec![("LLAMA_API_KEY", key.clone())],
                        secret: Some(key.clone()),
                        running: RunningInfo {
                            endpoint: format!("http://127.0.0.1:{port}"),
                            api_key: key,
                            quantization,
                            media,
                        },
                    })
                },
            )
            .await
    }

    pub async fn stop(&self) -> EmbeddingRuntimeStatus {
        self.core.stop().await
    }

    pub async fn remove(&self) -> Result<EmbeddingRuntimeStatus, String> {
        self.core.remove().await
    }
}

#[tauri::command]
pub async fn embedding_runtime_status(
    state: State<'_, EmbeddingState>,
) -> Result<EmbeddingRuntimeStatus, String> {
    state.status().await
}

#[tauri::command]
pub async fn embedding_runtime_install(
    state: State<'_, EmbeddingState>,
    request: InstallRequest,
) -> Result<EmbeddingRuntimeStatus, String> {
    state.install(request).await
}

#[tauri::command]
pub fn embedding_runtime_cancel(state: State<'_, EmbeddingState>) {
    state.cancel();
}

#[tauri::command]
pub async fn embedding_runtime_start(
    state: State<'_, EmbeddingState>,
    request: StartRequest,
) -> Result<EmbeddingRuntimeStatus, String> {
    state.start(request).await
}

#[tauri::command]
pub async fn embedding_runtime_stop(
    state: State<'_, EmbeddingState>,
) -> Result<EmbeddingRuntimeStatus, String> {
    Ok(state.stop().await)
}

#[tauri::command]
pub async fn embedding_runtime_remove(
    state: State<'_, EmbeddingState>,
) -> Result<EmbeddingRuntimeStatus, String> {
    state.remove().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_common::{
        install_runtime_archive, normalize, process_path, read_pidfile, verify_file, VerifyCache,
        DOWNLOADS_DIR,
    };
    use reqwest::{Client, StatusCode};
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    const PIDFILE: &str = "llama-server.pid";

    #[test]
    fn manifest_selects_the_pinned_archive_for_each_desktop_target() {
        let cases = [
            (
                "macos",
                "aarch64",
                "llama-b11696-bin-macos-arm64.tar.gz",
                ArchiveKind::TarGz,
            ),
            (
                "macos",
                "x86_64",
                "llama-b11696-bin-macos-x64.tar.gz",
                ArchiveKind::TarGz,
            ),
            (
                "linux",
                "x86_64",
                "llama-b11696-bin-ubuntu-x64.tar.gz",
                ArchiveKind::TarGz,
            ),
            (
                "linux",
                "aarch64",
                "llama-b11696-bin-ubuntu-arm64.tar.gz",
                ArchiveKind::TarGz,
            ),
            (
                "windows",
                "x86_64",
                "llama-b11696-bin-win-cpu-x64.zip",
                ArchiveKind::Zip,
            ),
            (
                "windows",
                "aarch64",
                "llama-b11696-bin-win-cpu-arm64.zip",
                ArchiveKind::Zip,
            ),
        ];
        for (os, arch, file, kind) in cases {
            let runtime = runtime_asset_for(os, arch).unwrap();
            assert_eq!(runtime.asset.file, file);
            assert_eq!(runtime.kind, kind);
            assert!(runtime.asset.bytes > 10_000_000);
        }
        assert_eq!(
            runtime_asset_for("windows", "x86_64").unwrap().asset.sha256,
            "1e7c47dff58467540d53e6cf302d83951bcb165afb252c2952ed3872190fc60d"
        );
        assert!(runtime_asset_for("linux", "riscv64").is_none());
        assert!(runtime_asset_for("freebsd", "x86_64").is_none());
        assert!(runtime_asset_for("ios", "aarch64").is_none());
        for asset in [Quantization::Q4.asset(), Quantization::Q8.asset(), MEDIA]
            .into_iter()
            .chain(
                cases
                    .iter()
                    .map(|(os, arch, ..)| runtime_asset_for(os, arch).unwrap().asset),
            )
        {
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn install_plan_downloads_only_missing_files_from_pinned_urls() {
        let root = Path::new("/data/embedding");
        let runtime = runtime_asset_for("macos", "aarch64").unwrap();
        let jobs = plan_jobs(root, runtime, &Installed::default(), Quantization::Q4, true);
        assert_eq!(jobs.len(), 3);
        assert_eq!(
            jobs[0].url,
            "https://github.com/ggml-org/llama.cpp/releases/download/b11696/llama-b11696-bin-macos-arm64.tar.gz"
        );
        assert_eq!(jobs[0].archive, Some(ArchiveKind::TarGz));
        // Only Hugging Face downloads may carry the writer's token.
        assert!(!jobs[0].hugging_face);
        assert_eq!(
            jobs[1].url,
            "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/embeddinggemma-2-UD-Q4_K_XL.gguf"
        );
        assert!(jobs[1].hugging_face && jobs[2].hugging_face);
        assert_eq!(
            jobs[2].destination,
            root.join("models").join("mmproj-Q8_0.gguf")
        );
        let installed = Installed {
            runtime: true,
            models: vec![Quantization::Q4],
            media: false,
        };
        let jobs = plan_jobs(root, runtime, &installed, Quantization::Q8, false);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].asset, Quantization::Q8.asset());
        assert!(plan_jobs(root, runtime, &installed, Quantization::Q4, false).is_empty());
        let request: InstallRequest =
            serde_json::from_str(r#"{"quantization":"Q8_0","media":true,"hfToken":"hf_abc"}"#)
                .unwrap();
        assert_eq!(request.hf_token.as_deref(), Some("hf_abc"));
        let request: InstallRequest =
            serde_json::from_str(r#"{"quantization":"Q8_0","hfToken":null}"#).unwrap();
        assert!(request.hf_token.is_none() && !request.media);
    }

    #[test]
    fn context_size_is_clamped_to_the_supported_range() {
        assert_eq!(clamp_context(0), 512);
        assert_eq!(clamp_context(511), 512);
        assert_eq!(clamp_context(2048), 2048);
        assert_eq!(clamp_context(8192), 8192);
        assert_eq!(clamp_context(u32::MAX), 8192);
        let request: StartRequest =
            serde_json::from_str(r#"{"quantization":"Q8_0","media":true,"contextSize":16384}"#)
                .unwrap();
        assert_eq!(request.quantization, Quantization::Q8);
        assert!(request.media);
        assert_eq!(clamp_context(request.context_size), 8192);
        let request: StartRequest =
            serde_json::from_str(r#"{"quantization":"UD-Q4_K_XL"}"#).unwrap();
        assert_eq!(request.context_size, DEFAULT_CONTEXT);
        assert!(serde_json::from_str::<InstallRequest>(r#"{"quantization":"Q4_0"}"#).is_err());
    }

    #[test]
    fn status_serializes_with_the_frontend_field_names() {
        let status = EmbeddingRuntimeStatus {
            state: RuntimeState::Running,
            installed: Installed {
                runtime: true,
                models: vec![Quantization::Q4, Quantization::Q8],
                media: true,
            },
            running: Some(RunningInfo {
                endpoint: "http://127.0.0.1:53124".into(),
                api_key: "secret".into(),
                quantization: Quantization::Q4,
                media: false,
            }),
            progress: Some(Progress {
                file: MEDIA.file.into(),
                downloaded_bytes: 10,
                total_bytes: 20,
            }),
            error: Some("Hugging Face asks for a sign-in token for this model.".into()),
            error_code: Some("huggingface-auth"),
            disk_bytes: 42,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "running");
        assert_eq!(json["installed"]["runtime"], true);
        assert_eq!(
            json["installed"]["models"],
            serde_json::json!(["UD-Q4_K_XL", "Q8_0"])
        );
        assert_eq!(json["installed"]["media"], true);
        assert_eq!(json["running"]["endpoint"], "http://127.0.0.1:53124");
        assert_eq!(json["running"]["apiKey"], "secret");
        assert_eq!(json["running"]["quantization"], "UD-Q4_K_XL");
        assert_eq!(json["running"]["media"], false);
        assert_eq!(json["progress"]["file"], "mmproj-Q8_0.gguf");
        assert_eq!(json["progress"]["downloadedBytes"], 10);
        assert_eq!(json["progress"]["totalBytes"], 20);
        assert_eq!(json["diskBytes"], 42);
        assert_eq!(json["errorCode"], "huggingface-auth");

        let idle = EmbeddingSpec::snapshot(&Inner::default(), true);
        let json = serde_json::to_value(&idle).unwrap();
        assert_eq!(json["state"], "idle");
        assert!(json.get("running").is_none() && json.get("progress").is_none());
        assert_eq!(
            serde_json::to_value(EmbeddingSpec::snapshot(&Inner::default(), false)).unwrap()
                ["state"],
            "unsupported"
        );
        let mut failed = Inner::default();
        failed.error = Some("broken".into());
        let json = serde_json::to_value(EmbeddingSpec::snapshot(&failed, true)).unwrap();
        assert_eq!(
            (json["state"].as_str(), json["error"].as_str()),
            (Some("error"), Some("broken"))
        );
        let mut downloading = Inner::default();
        downloading.installing = true;
        assert_eq!(
            EmbeddingSpec::snapshot(&downloading, true).state,
            RuntimeState::Downloading
        );
    }

    #[test]
    fn server_arguments_bound_the_batch_and_keep_the_key_off_the_command_line() {
        let args: Vec<String> = server_args(
            Path::new("/m/model.gguf"),
            Some(Path::new("/m/mmproj.gguf")),
            4096,
            53124,
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect();
        let joined = args.join(" ");
        assert!(joined.starts_with("--model /m/model.gguf --mmproj /m/mmproj.gguf --alias embeddinggemma2 --embeddings --pooling mean"));
        assert!(
            joined.contains("--ctx-size 4096 --batch-size 4096 --ubatch-size 4096 --parallel 1")
        );
        assert!(joined.contains("--host 127.0.0.1 --port 53124 --no-webui"));
        assert!(!joined.contains("api-key"));
        let text_only = server_args(Path::new("/m/model.gguf"), None, 512, 1);
        assert!(!text_only.iter().any(|arg| arg == "--mmproj"));
        let key = random_key().unwrap();
        assert_eq!(key.len(), 64);
        assert_ne!(key, random_key().unwrap());
    }

    #[tokio::test]
    async fn status_reports_verified_files_and_removal_clears_the_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("embedding");
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let state = EmbeddingState::with_runtime(root.clone(), runtime_asset(), move |status| {
            seen.lock().unwrap().push(status.clone())
        });
        let status = state.status().await.unwrap();
        assert_eq!(status.installed, Installed::default());
        assert_eq!(status.disk_bytes, 0);
        // A file with the pinned name but wrong content is not installed.
        fs::create_dir_all(root.join(MODELS_DIR)).unwrap();
        fs::write(root.join(MODELS_DIR).join(MEDIA.file), b"not a model").unwrap();
        let status = state.status().await.unwrap();
        assert!(!status.installed.media);
        assert_eq!(status.disk_bytes, 11);
        let error = state
            .start(StartRequest {
                quantization: Quantization::Q4,
                media: false,
                context_size: 2048,
            })
            .await;
        if runtime_asset().is_some() {
            assert!(error.unwrap_err().contains("Download"));
        }
        let status = state.remove().await.unwrap();
        assert!(!root.exists());
        assert_eq!(status.disk_bytes, 0);
        assert_eq!(events.lock().unwrap().len(), 1);
        state.cancel();
        assert!(state.stop().await.running.is_none());
    }

    fn link_or_copy(from: &Path, to: &Path) {
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        if fs::hard_link(from, to).is_err() {
            fs::copy(from, to).unwrap();
        }
    }

    /// Runs the real server from a prepared directory. Point
    /// TYPENEXT_EMBEDDING_TEST_DIR at a folder holding the pinned llama.cpp
    /// archive for this platform (as `llama.tar.gz`/`llama.zip` or its release
    /// name), `eg2-q4.gguf` and optionally `mmproj-q8.gguf`, then run
    /// `cargo test -- --ignored managed_server`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a local llama.cpp build and EmbeddingGemma 2 weights"]
    async fn managed_server_serves_authenticated_embeddings() {
        let source = PathBuf::from(
            std::env::var_os("TYPENEXT_EMBEDDING_TEST_DIR")
                .expect("set TYPENEXT_EMBEDDING_TEST_DIR"),
        );
        let runtime = runtime_asset().expect("unsupported platform");
        let archive = [runtime.asset.file, "llama.tar.gz", "llama.zip"]
            .into_iter()
            .map(|name| source.join(name))
            .find(|path| path.is_file())
            .expect("the pinned llama.cpp archive is missing");
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("embedding");
        let downloads = root.join(DOWNLOADS_DIR).join(runtime.asset.file);
        link_or_copy(&archive, &downloads);
        link_or_copy(
            &source.join("eg2-q4.gguf"),
            &root.join(MODELS_DIR).join(Quantization::Q4.asset().file),
        );
        let media = source.join("mmproj-q8.gguf").is_file();
        if media {
            link_or_copy(
                &source.join("mmproj-q8.gguf"),
                &root.join(MODELS_DIR).join(MEDIA.file),
            );
        }
        // The archive is verified against the pinned hash before extraction.
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
        let state = EmbeddingState::new(root.clone(), move |status| {
            seen.lock().unwrap().push(status.state)
        });
        let started = Instant::now();
        let status = state.status().await.unwrap();
        println!("first verification took {:?}", started.elapsed());
        assert!(status.installed.runtime);
        assert_eq!(status.installed.models, vec![Quantization::Q4]);
        assert_eq!(status.installed.media, media);

        let started = Instant::now();
        let status = state
            .start(StartRequest {
                quantization: Quantization::Q4,
                media: false,
                context_size: 2048,
            })
            .await
            .unwrap();
        println!("text server ready in {:?}", started.elapsed());
        assert_eq!(status.state, RuntimeState::Running);
        let running = status.running.clone().unwrap();
        assert!(running.endpoint.starts_with("http://127.0.0.1:"));
        let record = read_pidfile(&root.join(PIDFILE)).unwrap();
        assert_eq!(
            process_path(record.pid).map(|path| normalize(&path)),
            Some(record.path.clone())
        );
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [RuntimeState::Starting, RuntimeState::Running]
        );

        let client = Client::new();
        let health: serde_json::Value = client
            .get(format!("{}/health", running.endpoint))
            .bearer_auth(&running.api_key)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["status"], "ok");
        let request = serde_json::json!({ "model": MODEL_ALIAS, "input": ["task: search result | query: calm notes"] });
        let unauthorized = client
            .post(format!("{}/v1/embeddings", running.endpoint))
            .json(&request)
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        let embeddings: serde_json::Value = client
            .post(format!("{}/v1/embeddings", running.endpoint))
            .bearer_auth(&running.api_key)
            .json(&request)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let vector = embeddings["data"][0]["embedding"].as_array().unwrap();
        println!("embedding dimensions: {}", vector.len());
        assert!(vector.len() >= 128);

        // The same launch is reused without restarting.
        let again = state
            .start(StartRequest {
                quantization: Quantization::Q4,
                media: false,
                context_size: 4096,
            })
            .await
            .unwrap();
        assert_eq!(again.running.unwrap().endpoint, running.endpoint);

        if media {
            let started = Instant::now();
            let status = state
                .start(StartRequest {
                    quantization: Quantization::Q4,
                    media: true,
                    context_size: 8192,
                })
                .await
                .unwrap();
            println!("media server ready in {:?}", started.elapsed());
            let media_running = status.running.unwrap();
            assert!(media_running.media);
            assert_ne!(media_running.api_key, running.api_key);
            // The previous text-only server was stopped.
            assert!(client
                .get(format!("{}/health", running.endpoint))
                .send()
                .await
                .is_err());
            // A text-only request reuses the media launch.
            let reused = state
                .start(StartRequest {
                    quantization: Quantization::Q4,
                    media: false,
                    context_size: 2048,
                })
                .await
                .unwrap();
            assert_eq!(reused.running.unwrap().endpoint, media_running.endpoint);
        }

        let endpoint = state.core.snapshot().running.unwrap().endpoint;
        let status = state.stop().await;
        assert!(!root.join(PIDFILE).exists());
        assert_eq!(status.state, RuntimeState::Idle);
        assert!(status.running.is_none());
        assert!(client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .is_err());

        // Exit cleanup kills a running server synchronously.
        state
            .start(StartRequest {
                quantization: Quantization::Q4,
                media: false,
                context_size: 512,
            })
            .await
            .unwrap();
        let endpoint = state.core.snapshot().running.unwrap().endpoint;
        drop(state);
        assert!(client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .is_err());
    }
}
