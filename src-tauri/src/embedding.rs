//! Managed EmbeddingGemma 2 runtime: a pinned llama.cpp build and GGUF weights
//! that are downloaded only on an explicit writer action, verified with SHA-256
//! and served by `llama-server --embeddings` on a private loopback port.

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use tauri::State;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub const STATUS_EVENT: &str = "embedding-runtime-status";
const LLAMA_RELEASE: &str = "b11696";
const RUNTIME_BASE_URL: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b11696/";
const MODEL_BASE_URL: &str =
    "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/";
const RUNTIME_DIR: &str = "runtime-b11696";
const MODELS_DIR: &str = "models";
const DOWNLOADS_DIR: &str = "downloads";
const RUNTIME_MARKER: &str = ".typenext-runtime.json";
const PIDFILE: &str = "llama-server.pid";
const MAX_PIDFILE_BYTES: u64 = 16 * 1024;
const MAX_MARKER_BYTES: u64 = 4 * 1024 * 1024;
const MODEL_ALIAS: &str = "embeddinggemma2";
#[cfg(target_os = "windows")]
const SERVER_BINARY: &str = "llama-server.exe";
#[cfg(not(target_os = "windows"))]
const SERVER_BINARY: &str = "llama-server";
const MIN_CONTEXT: u32 = 512;
const MAX_CONTEXT: u32 = 8192;
const DEFAULT_CONTEXT: u32 = 2048;
const START_TIMEOUT: Duration = Duration::from_secs(90);
const HEALTH_INTERVAL: Duration = Duration::from_millis(250);
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const LOG_LINES: usize = 40;
const LOG_LINE_BYTES: u64 = 4096;
const LOG_LINE_CHARS: usize = 400;
const CANCELLED: &str = "Download cancelled";
const START_CANCELLED: &str = "The embedding server start was cancelled";
const UNSUPPORTED: &str = "The managed embedding runtime is not available for this platform";
const UNSAFE_ARCHIVE: &str = "The llama.cpp archive contains an unsafe path and was not installed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Asset {
    file: &'static str,
    bytes: u64,
    sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RuntimeAsset {
    asset: Asset,
    kind: ArchiveKind,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    Unsupported,
    Idle,
    Downloading,
    Starting,
    Running,
    Error,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    file: String,
    downloaded_bytes: u64,
    total_bytes: u64,
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
    disk_bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    quantization: Quantization,
    #[serde(default)]
    media: bool,
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

// Verification -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

/// Per-session SHA-256 results, keyed by path and invalidated when the file's
/// size or modification time changes.
type VerifyCache = HashMap<PathBuf, (Stamp, bool)>;

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn hash_into(reader: &mut impl Read, hasher: &mut Sha256) -> io::Result<u64> {
    let mut buffer = vec![0; 1 << 20];
    let mut total = 0;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(total),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    hash_into(&mut File::open(path)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

fn verify_file(cache: &mut VerifyCache, path: &Path, bytes: u64, sha256: &str) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() || metadata.len() != bytes {
        return false;
    }
    let stamp = Stamp {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    };
    if let Some((cached, verified)) = cache.get(path) {
        if *cached == stamp {
            return *verified;
        }
    }
    let verified = sha256_file(path).is_ok_and(|digest| digest.eq_ignore_ascii_case(sha256));
    cache.insert(path.to_path_buf(), (stamp, verified));
    verified
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeMarker {
    release: String,
    archive_sha256: String,
    server: String,
    files: Vec<MarkerFile>,
    #[serde(default)]
    links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct MarkerFile {
    path: String,
    bytes: u64,
    sha256: String,
}

fn read_marker(path: &Path) -> Option<RuntimeMarker> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MARKER_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The extracted runtime is trusted only when its marker names the pinned
/// archive and every extracted file still matches the hash recorded at
/// extraction time.
fn verified_server(root: &Path, runtime: RuntimeAsset, cache: &mut VerifyCache) -> Option<PathBuf> {
    let directory = root.join(RUNTIME_DIR);
    let marker = read_marker(&directory.join(RUNTIME_MARKER))?;
    if marker.release != LLAMA_RELEASE
        || !marker
            .archive_sha256
            .eq_ignore_ascii_case(runtime.asset.sha256)
    {
        return None;
    }
    let mut server = None;
    for file in &marker.files {
        let path = directory.join(sanitize_entry_path(&file.path).ok()??);
        if !verify_file(cache, &path, file.bytes, &file.sha256) {
            return None;
        }
        if file.path == marker.server {
            server = Some(path);
        }
    }
    for link in &marker.links {
        let path = directory.join(sanitize_entry_path(link).ok()??);
        fs::symlink_metadata(path).ok()?;
    }
    server
}

fn scan_installed(
    root: &Path,
    runtime: Option<RuntimeAsset>,
    cache: &mut VerifyCache,
) -> (Installed, Option<PathBuf>) {
    let server = runtime.and_then(|runtime| verified_server(root, runtime, cache));
    let models = root.join(MODELS_DIR);
    let installed = Installed {
        runtime: server.is_some(),
        models: Quantization::ALL
            .into_iter()
            .filter(|quantization| {
                let asset = quantization.asset();
                verify_file(cache, &models.join(asset.file), asset.bytes, asset.sha256)
            })
            .collect(),
        media: verify_file(cache, &models.join(MEDIA.file), MEDIA.bytes, MEDIA.sha256),
    };
    (installed, server)
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map_or(0, |metadata| metadata.len()),
            _ => 0,
        })
        .sum()
}

// Archive extraction -------------------------------------------------------

/// Archive member names become relative paths with no root, drive, `..` or
/// alternate data stream. `None` is an entry that names the archive root.
fn sanitize_entry_path(raw: &str) -> Result<Option<PathBuf>, String> {
    if raw.contains('\0') || raw.starts_with(['/', '\\']) {
        return Err(UNSAFE_ARCHIVE.into());
    }
    let mut path = PathBuf::new();
    for part in raw.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => return Err(UNSAFE_ARCHIVE.into()),
            part if part.contains(':') => return Err(UNSAFE_ARCHIVE.into()),
            part => path.push(part),
        }
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(UNSAFE_ARCHIVE.into());
    }
    Ok((!path.as_os_str().is_empty()).then_some(path))
}

/// Archive symlinks may only name a plain file in their own directory, such
/// as `libllama.dylib -> libllama.0.dylib`.
fn sibling_link_target(link: &Path, target: &str) -> Option<PathBuf> {
    let plain = !target.is_empty()
        && target != "."
        && target != ".."
        && !target.contains(['/', '\\', ':', '\0']);
    plain.then(|| link.parent().unwrap_or(Path::new("")).join(target))
}

/// Follows a chain of sibling links to the regular file it ends at.
fn resolve_link(
    link: &Path,
    links: &HashMap<PathBuf, String>,
    files: &BTreeMap<PathBuf, MarkerFile>,
) -> Option<PathBuf> {
    let mut current = link.to_path_buf();
    for _ in 0..8 {
        let target = sibling_link_target(&current, links.get(&current)?)?;
        if files.contains_key(&target) {
            return Some(target);
        }
        current = target;
    }
    None
}

fn portable(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The single folder every entry shares, such as `llama-b11696/`. The Windows
/// archives have no top-level folder.
fn common_top_directory<'a>(paths: impl Iterator<Item = &'a PathBuf>) -> Option<PathBuf> {
    let mut top: Option<&std::ffi::OsStr> = None;
    for path in paths {
        let mut components = path.components();
        let first = components.next()?.as_os_str();
        components.next()?;
        match top {
            Some(existing) if existing != first => return None,
            _ => top = Some(first),
        }
    }
    top.map(PathBuf::from)
}

#[derive(Default)]
struct Extracted {
    files: BTreeMap<PathBuf, MarkerFile>,
    links: HashMap<PathBuf, String>,
}

fn archive_error(error: impl std::fmt::Display) -> String {
    format!("Could not extract the llama.cpp runtime: {error}")
}

#[cfg(unix)]
fn unix_permissions(relative: &Path, mode: Option<u32>) -> u32 {
    let executable = mode.is_some_and(|mode| mode & 0o111 != 0)
        || relative
            .file_name()
            .is_some_and(|name| name == SERVER_BINARY);
    if executable {
        0o755
    } else {
        0o644
    }
}

fn write_entry(
    staging: &Path,
    relative: PathBuf,
    reader: &mut impl Read,
    mode: Option<u32>,
    extracted: &mut Extracted,
) -> Result<(), String> {
    let path = staging.join(&relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(archive_error)?;
    }
    if fs::symlink_metadata(&path).is_ok() {
        fs::remove_file(&path).map_err(archive_error)?;
    }
    let mut file = File::create(&path).map_err(archive_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    let mut bytes = 0;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(archive_error(error)),
        };
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read]).map_err(archive_error)?;
        bytes += read as u64;
    }
    file.flush().map_err(archive_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(unix_permissions(&relative, mode)),
        )
        .map_err(archive_error)?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    extracted.links.remove(&relative);
    extracted.files.insert(
        relative.clone(),
        MarkerFile {
            path: portable(&relative),
            bytes,
            sha256: hex(&hasher.finalize()),
        },
    );
    Ok(())
}

fn utf8_name(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec()).map_err(|_| UNSAFE_ARCHIVE.to_string())
}

fn extract_tar_gz(archive: &Path, staging: &Path) -> Result<Extracted, String> {
    let file = File::open(archive).map_err(archive_error)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)));
    let mut extracted = Extracted::default();
    for entry in tar.entries().map_err(archive_error)? {
        let mut entry = entry.map_err(archive_error)?;
        let raw = utf8_name(&entry.path_bytes())?;
        let Some(relative) = sanitize_entry_path(&raw)? else {
            continue;
        };
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            fs::create_dir_all(staging.join(&relative)).map_err(archive_error)?;
        } else if matches!(kind, tar::EntryType::Regular | tar::EntryType::Continuous) {
            let mode = entry.header().mode().ok();
            write_entry(staging, relative, &mut entry, mode, &mut extracted)?;
        } else if kind.is_symlink() {
            let target = match entry.link_name_bytes() {
                Some(target) => utf8_name(&target)?,
                None => String::new(),
            };
            extracted.files.remove(&relative);
            extracted.links.insert(relative, target);
        } else {
            log::warn!("Skipping an unsupported llama.cpp archive entry: {raw}");
        }
    }
    Ok(extracted)
}

fn extract_zip(archive: &Path, staging: &Path) -> Result<Extracted, String> {
    let file = File::open(archive).map_err(archive_error)?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(archive_error)?;
    let mut extracted = Extracted::default();
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(archive_error)?;
        let raw = entry.name().map_err(archive_error)?.into_owned();
        let Some(relative) = sanitize_entry_path(&raw)? else {
            continue;
        };
        if entry.is_dir() {
            fs::create_dir_all(staging.join(&relative)).map_err(archive_error)?;
        } else if entry.is_symlink() {
            let mut target = String::new();
            (&mut entry)
                .take(1024)
                .read_to_string(&mut target)
                .map_err(archive_error)?;
            extracted.files.remove(&relative);
            extracted.links.insert(relative, target);
        } else if entry.is_file() {
            let mode = entry.unix_mode();
            write_entry(staging, relative, &mut entry, mode, &mut extracted)?;
        } else {
            log::warn!("Skipping an unsupported llama.cpp archive entry: {raw}");
        }
    }
    Ok(extracted)
}

/// Extracts a verified archive beside the final directory, records a hash
/// manifest and swaps the complete directory into place.
fn install_runtime_archive(
    root: &Path,
    archive: &Path,
    kind: ArchiveKind,
    archive_sha256: &str,
) -> Result<(), String> {
    fs::create_dir_all(root).map_err(archive_error)?;
    let staging = tempfile::Builder::new()
        .prefix(".runtime-")
        .tempdir_in(root)
        .map_err(archive_error)?;
    #[cfg_attr(unix, allow(unused_mut))]
    let mut extracted = match kind {
        ArchiveKind::TarGz => extract_tar_gz(archive, staging.path())?,
        ArchiveKind::Zip => extract_zip(archive, staging.path())?,
    };

    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut links = Vec::new();
    let mut link_paths: Vec<_> = extracted.links.keys().cloned().collect();
    link_paths.sort();
    for link in link_paths {
        let Some(resolved) = resolve_link(&link, &extracted.links, &extracted.files) else {
            log::warn!(
                "Skipping an unsafe or dangling llama.cpp archive link: {}",
                portable(&link)
            );
            continue;
        };
        let link_path = staging.path().join(&link);
        if let Some(parent) = link_path.parent() {
            fs::create_dir_all(parent).map_err(archive_error)?;
        }
        #[cfg(unix)]
        {
            let name = resolved
                .file_name()
                .ok_or_else(|| archive_error("bad link"))?;
            std::os::unix::fs::symlink(name, &link_path).map_err(archive_error)?;
            links.push(link);
        }
        #[cfg(not(unix))]
        {
            fs::copy(staging.path().join(&resolved), &link_path).map_err(archive_error)?;
            let record = extracted.files[&resolved].clone();
            extracted.files.insert(
                link.clone(),
                MarkerFile {
                    path: portable(&link),
                    ..record
                },
            );
        }
    }

    let top = common_top_directory(extracted.files.keys().chain(links.iter()));
    let strip = |path: &Path| -> PathBuf {
        top.as_deref()
            .and_then(|top| path.strip_prefix(top).ok())
            .unwrap_or(path)
            .to_path_buf()
    };
    let files: Vec<MarkerFile> = extracted
        .files
        .iter()
        .map(|(path, file)| MarkerFile {
            path: portable(&strip(path)),
            ..file.clone()
        })
        .collect();
    let server = files
        .iter()
        .filter(|file| file.path.rsplit('/').next() == Some(SERVER_BINARY))
        .min_by_key(|file| file.path.matches('/').count())
        .map(|file| file.path.clone())
        .ok_or_else(|| archive_error(format!("{SERVER_BINARY} is missing")))?;
    let marker = RuntimeMarker {
        release: LLAMA_RELEASE.into(),
        archive_sha256: archive_sha256.to_ascii_lowercase(),
        server,
        files,
        links: links.iter().map(|link| portable(&strip(link))).collect(),
    };

    let content = match &top {
        Some(top) => staging.path().join(top),
        None => staging.path().to_path_buf(),
    };
    let mut marker_file = File::create(content.join(RUNTIME_MARKER)).map_err(archive_error)?;
    serde_json::to_writer(&mut marker_file, &marker).map_err(archive_error)?;
    marker_file.sync_all().map_err(archive_error)?;
    drop(marker_file);

    let destination = root.join(RUNTIME_DIR);
    match fs::remove_dir_all(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(archive_error(error)),
    }
    fs::rename(&content, &destination).map_err(archive_error)?;
    // Dropping the staging directory removes anything left beside the content.
    Ok(())
}

// Downloads ---------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Job {
    asset: Asset,
    url: String,
    destination: PathBuf,
    archive: Option<ArchiveKind>,
}

fn model_job(root: &Path, asset: Asset) -> Job {
    Job {
        asset,
        url: format!("{MODEL_BASE_URL}{}", asset.file),
        destination: root.join(MODELS_DIR).join(asset.file),
        archive: None,
    }
}

fn plan_jobs(
    root: &Path,
    runtime: RuntimeAsset,
    installed: &Installed,
    request: &InstallRequest,
) -> Vec<Job> {
    let mut jobs = Vec::new();
    if !installed.runtime {
        jobs.push(Job {
            asset: runtime.asset,
            url: format!("{RUNTIME_BASE_URL}{}", runtime.asset.file),
            destination: root.join(DOWNLOADS_DIR).join(runtime.asset.file),
            archive: Some(runtime.kind),
        });
    }
    if !installed.models.contains(&request.quantization) {
        jobs.push(model_job(root, request.quantization.asset()));
    }
    if request.media && !installed.media {
        jobs.push(model_job(root, MEDIA));
    }
    jobs
}

fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    destination.with_file_name(name)
}

/// GitHub and Hugging Face both redirect to CDNs. Unlike the provider client
/// in http.rs, this client follows HTTPS redirects and never carries
/// credentials, and it leaves bodies undecoded so hashes see the exact bytes.
fn download_client(https_only: bool) -> Result<Client, String> {
    Client::builder()
        .https_only(https_only)
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .no_gzip()
        .no_brotli()
        .user_agent(concat!("TypeNext/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not prepare the download client".into())
}

fn download_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The download stalled. Check your connection and try again to resume it.".into()
    } else if error.is_connect() {
        "Could not reach the download server. Check your connection and try again.".into()
    } else {
        // Never expose the CDN URL or its signed query through the error.
        "The download was interrupted. Try again to resume it.".into()
    }
}

fn io_error(error: io::Error) -> String {
    format!("Could not save the embedding files: {error}")
}

fn content_range_starts_at(response: &reqwest::Response, offset: u64) -> bool {
    response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with(&format!("bytes {offset}-")))
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "The embedding runtime task stopped unexpectedly".to_string())
}

async fn resume_state(part: PathBuf, asset: Asset) -> Result<(Sha256, u64), String> {
    blocking(move || -> Result<(Sha256, u64), String> {
        let Ok(metadata) = fs::symlink_metadata(&part) else {
            return Ok((Sha256::new(), 0));
        };
        if !metadata.is_file() || metadata.len() > asset.bytes {
            fs::remove_file(&part).map_err(io_error)?;
            return Ok((Sha256::new(), 0));
        }
        let mut hasher = Sha256::new();
        let read =
            hash_into(&mut File::open(&part).map_err(io_error)?, &mut hasher).map_err(io_error)?;
        Ok((hasher, read))
    })
    .await?
}

/// Streams into `<file>.part`, hashing as it writes, resumes an earlier part
/// with an HTTP range request and renames the file into place only after its
/// size and SHA-256 match the pinned manifest.
async fn download_verified(
    client: &Client,
    url: &str,
    destination: &Path,
    asset: Asset,
    token: &CancellationToken,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
    }
    if tokio::fs::symlink_metadata(destination).await.is_ok() {
        let path = destination.to_path_buf();
        let verified = blocking(move || {
            verify_file(&mut VerifyCache::new(), &path, asset.bytes, asset.sha256)
        })
        .await?;
        if verified {
            progress(asset.bytes);
            return Ok(());
        }
        tokio::fs::remove_file(destination)
            .await
            .map_err(io_error)?;
    }
    let part = part_path(destination);
    let (mut hasher, mut offset) = resume_state(part.clone(), asset).await?;
    progress(offset);
    if offset < asset.bytes {
        let mut request = client.get(url);
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let mut response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(CANCELLED.into()),
            response = request.send() => response.map_err(download_error)?,
        };
        let status = response.status();
        let resumed = offset > 0
            && status == StatusCode::PARTIAL_CONTENT
            && content_range_starts_at(&response, offset);
        if !resumed {
            if status != StatusCode::OK {
                return Err(format!(
                    "The download server returned HTTP {} for {}",
                    status.as_u16(),
                    asset.file
                ));
            }
            hasher = Sha256::new();
            offset = 0;
        }
        if response
            .content_length()
            .is_some_and(|length| length != asset.bytes - offset)
        {
            return Err(format!(
                "The download server reported an unexpected size for {}",
                asset.file
            ));
        }
        let opened = if resumed {
            tokio::fs::OpenOptions::new().append(true).open(&part).await
        } else {
            tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&part)
                .await
        };
        let mut file = opened.map_err(io_error)?;
        loop {
            let chunk = tokio::select! {
                biased;
                _ = token.cancelled() => return Err(CANCELLED.into()),
                chunk = response.chunk() => chunk.map_err(download_error)?,
            };
            let Some(chunk) = chunk else {
                break;
            };
            offset += chunk.len() as u64;
            if offset > asset.bytes {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("{} is larger than the pinned file", asset.file));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(io_error)?;
            progress(offset);
        }
        file.flush().await.map_err(io_error)?;
        file.sync_all().await.map_err(io_error)?;
    }
    if offset != asset.bytes {
        return Err("The download ended early. Try again to resume it.".into());
    }
    if !hex(&hasher.finalize()).eq_ignore_ascii_case(asset.sha256) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "{} failed its SHA-256 check and was discarded. Try the download again.",
            asset.file
        ));
    }
    tokio::fs::rename(&part, destination)
        .await
        .map_err(io_error)?;
    Ok(())
}

// Server process -----------------------------------------------------------

type LogBuffer = Arc<Mutex<VecDeque<String>>>;

struct Server {
    child: Child,
    info: RunningInfo,
    ready: bool,
    launch: u64,
    logs: LogBuffer,
    pidfile: Option<PathBuf>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(pidfile) = &self.pidfile {
            remove_pidfile_for(pidfile, self.child.id());
        }
    }
}

// Orphan cleanup -------------------------------------------------------------

/// Written beside the runtime while a server runs so a server orphaned by a
/// crash or force-quit can be found and stopped on the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PidRecord {
    pid: u32,
    /// The TypeNext process that launched the server.
    owner: u32,
    path: PathBuf,
    started_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrphanAction {
    /// Its owner is still running, as with a second TypeNext window.
    Keep,
    /// Stale record: the process is gone or is not our llama-server.
    Discard,
    Terminate,
}

fn parse_pidfile(text: &str) -> Option<PidRecord> {
    let record: PidRecord = serde_json::from_str(text).ok()?;
    (record.pid != 0 && record.pid != std::process::id() && record.path.is_absolute())
        .then_some(record)
}

/// Paths must already be normalized. A process is only ever terminated when
/// its live executable is the managed llama-server recorded for it.
fn orphan_action(
    record: &PidRecord,
    runtime_dir: &Path,
    live_path: Option<&Path>,
    owner_alive: bool,
) -> OrphanAction {
    let Some(live_path) = live_path else {
        return OrphanAction::Discard;
    };
    if owner_alive {
        return OrphanAction::Keep;
    }
    let managed = record.path.starts_with(runtime_dir)
        && !record
            .path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && record
            .path
            .file_name()
            .is_some_and(|name| name == SERVER_BINARY);
    if managed && live_path == record.path {
        OrphanAction::Terminate
    } else {
        OrphanAction::Discard
    }
}

fn normalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn write_pidfile(root: &Path, pid: u32, binary: &Path) -> Option<PathBuf> {
    let record = PidRecord {
        pid,
        owner: std::process::id(),
        path: normalize(binary),
        started_at: unix_time(),
    };
    let path = root.join(PIDFILE);
    let written = serde_json::to_vec(&record)
        .map_err(io::Error::other)
        .and_then(|bytes| {
            let mut file = tempfile::Builder::new()
                .prefix(".llama-server.pid-")
                .tempfile_in(root)?;
            file.write_all(&bytes)?;
            file.persist(&path).map_err(|error| error.error)?;
            Ok(())
        });
    match written {
        Ok(()) => Some(path),
        Err(error) => {
            log::warn!("Could not record the embedding server process: {error}");
            None
        }
    }
}

fn read_pidfile(path: &Path) -> Option<PidRecord> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PIDFILE_BYTES {
        return None;
    }
    parse_pidfile(&fs::read_to_string(path).ok()?)
}

/// Removes the pidfile only while it still describes `pid`, so a newer
/// server's record survives an older server being dropped.
fn remove_pidfile_for(path: &Path, pid: u32) {
    let current = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<PidRecord>(&text).ok());
    if current.is_some_and(|record| record.pid == pid) {
        let _ = fs::remove_file(path);
    }
}

/// Stops a llama-server left running by a TypeNext that crashed or was
/// force-quit. Never signals a process whose executable does not match.
fn reap_orphan(root: &Path) {
    let path = root.join(PIDFILE);
    if fs::symlink_metadata(&path).is_err() {
        return;
    }
    let Some(record) = read_pidfile(&path) else {
        let _ = fs::remove_file(&path);
        return;
    };
    let live_path = process_path(record.pid).map(|path| normalize(&path));
    let owner_alive = record.owner == std::process::id() || process_path(record.owner).is_some();
    let record = PidRecord {
        path: normalize(&record.path),
        ..record
    };
    match orphan_action(
        &record,
        &normalize(&root.join(RUNTIME_DIR)),
        live_path.as_deref(),
        owner_alive,
    ) {
        OrphanAction::Keep => return,
        OrphanAction::Discard => {}
        OrphanAction::Terminate => {
            log::warn!(
                "Stopping an embedding server left running since {}",
                record.started_at
            );
            if !terminate_process(record.pid) {
                log::warn!("Could not stop the orphaned embedding server");
                return;
            }
        }
    }
    let _ = fs::remove_file(&path);
}

#[cfg(target_os = "macos")]
fn process_path(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStringExt;
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is writable for the size passed to the call.
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(OsString::from_vec(buffer)))
}

#[cfg(target_os = "linux")]
fn process_path(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let path = fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    // A replaced executable reads as "<path> (deleted)".
    let bytes = path.as_os_str().as_bytes();
    let bytes = bytes.strip_suffix(b" (deleted)").unwrap_or(bytes);
    Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

#[cfg(target_os = "windows")]
fn process_path(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: the handle is checked and closed; buffers outlive each call.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut exit_code = 0;
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let alive = GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE;
        let named = alive
            && QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            ) != 0;
        CloseHandle(handle);
        named.then(|| PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn process_path(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: kill only sends a signal to the verified process id.
    if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
        return false;
    }
    // The orphan belongs to init/launchd now, which reaps it promptly.
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if process_path(pid as u32).is_none() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[cfg(target_os = "windows")]
fn terminate_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };
    // SAFETY: the handle is checked before use and closed afterwards.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let stopped = TerminateProcess(handle, 1) != 0 && WaitForSingleObject(handle, 2000) == 0;
        CloseHandle(handle);
        stopped
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn terminate_process(_pid: u32) -> bool {
    false
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

fn server_command(binary: &Path, args: Vec<OsString>, api_key: &str) -> Command {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Inherited LLAMA_* variables could reconfigure the server, for example to
    // listen on every interface. The key travels in the environment so other
    // local users cannot read it from the process list.
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("LLAMA_") {
            command.env_remove(name);
        }
    }
    command.env("LLAMA_API_KEY", api_key);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn capture(pipe: Option<impl Read + Send + 'static>, logs: &LogBuffer, secret: &str) {
    let Some(pipe) = pipe else {
        return;
    };
    let logs = logs.clone();
    let secret = secret.to_owned();
    // The pipes are drained for the server's whole life so it never blocks on
    // a full buffer. Each thread ends when the process closes its output.
    let spawned = std::thread::Builder::new()
        .name("llama-server-log".into())
        .spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut line = Vec::new();
            loop {
                line.clear();
                match (&mut reader)
                    .take(LOG_LINE_BYTES)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = String::from_utf8_lossy(&line).replace(&secret, "<redacted>");
                let text: String = text.trim_end().chars().take(LOG_LINE_CHARS).collect();
                if text.is_empty() {
                    continue;
                }
                let mut logs = logs.lock().unwrap_or_else(PoisonError::into_inner);
                if logs.len() == LOG_LINES {
                    logs.pop_front();
                }
                logs.push_back(text);
            }
        });
    if let Err(error) = spawned {
        log::warn!("Could not capture llama-server output: {error}");
    }
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| {
            format!("Could not reserve a local port for the embedding server: {error}")
        })
}

fn api_key() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Could not generate a key for the embedding server".to_string())?;
    Ok(hex(&bytes))
}

fn start_failure(reason: &str, logs: &[String]) -> String {
    if !logs.is_empty() {
        log::warn!("llama-server output before failure:\n{}", logs.join("\n"));
    }
    let relevant = logs
        .iter()
        .rev()
        .find(|line| {
            let line = line.to_ascii_lowercase();
            ["error", "failed", "unable", "cannot", "couldn't", "invalid"]
                .iter()
                .any(|word| line.contains(word))
        })
        .or_else(|| logs.last());
    match relevant {
        Some(line) => format!("{reason}: {}", line.trim()),
        None => reason.to_string(),
    }
}

enum StartError {
    Cancelled,
    PortTaken,
    Failed(String),
}

impl StartError {
    fn message(self) -> String {
        match self {
            Self::Cancelled => START_CANCELLED.into(),
            Self::PortTaken => "Could not find a free local port for the embedding server".into(),
            Self::Failed(message) => message,
        }
    }
}

// State --------------------------------------------------------------------

#[derive(Default)]
struct Inner {
    installing: bool,
    starting: bool,
    progress: Option<Progress>,
    error: Option<String>,
    installed: Installed,
    server_binary: Option<PathBuf>,
    disk_bytes: u64,
    verified: VerifyCache,
    server: Option<Server>,
    install_token: Option<CancellationToken>,
    start_token: Option<CancellationToken>,
    launch: u64,
}

fn snapshot(inner: &Inner, supported: bool) -> EmbeddingRuntimeStatus {
    let running = inner
        .server
        .as_ref()
        .filter(|server| server.ready)
        .map(|server| server.info.clone());
    let state = if !supported {
        RuntimeState::Unsupported
    } else if inner.installing {
        RuntimeState::Downloading
    } else if inner.starting {
        RuntimeState::Starting
    } else if inner.error.is_some() {
        RuntimeState::Error
    } else if running.is_some() {
        RuntimeState::Running
    } else {
        RuntimeState::Idle
    };
    EmbeddingRuntimeStatus {
        state,
        installed: inner.installed.clone(),
        running,
        progress: inner.progress.clone(),
        error: inner.error.clone(),
        disk_bytes: inner.disk_bytes,
    }
}

/// Clears a ready server whose process has exited and records why. A server
/// that is still starting belongs to its `start` call, which reports failures.
fn reap_exited(inner: &mut Inner) -> Option<Server> {
    let server = inner.server.as_mut().filter(|server| server.ready)?;
    let exit = match server.child.try_wait() {
        Ok(None) => return None,
        Ok(Some(status)) => status.to_string(),
        Err(error) => error.to_string(),
    };
    let server = inner.server.take()?;
    let logs: Vec<String> = server
        .logs
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .cloned()
        .collect();
    inner.error = Some(start_failure(
        &format!("The embedding server stopped unexpectedly ({exit})"),
        &logs,
    ));
    Some(server)
}

type Emitter = Arc<dyn Fn(&EmbeddingRuntimeStatus) + Send + Sync>;

pub struct EmbeddingState {
    root: PathBuf,
    runtime: Option<RuntimeAsset>,
    emit: Emitter,
    inner: Arc<Mutex<Inner>>,
    // Lock order: install, server, verify.
    install_lock: tokio::sync::Mutex<()>,
    server_lock: tokio::sync::Mutex<()>,
    verify_lock: tokio::sync::Mutex<()>,
}

impl Drop for EmbeddingState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl EmbeddingState {
    pub fn new(
        root: PathBuf,
        emit: impl Fn(&EmbeddingRuntimeStatus) + Send + Sync + 'static,
    ) -> Self {
        reap_orphan(&root);
        Self::with_runtime(root, runtime_asset(), emit)
    }

    fn with_runtime(
        root: PathBuf,
        runtime: Option<RuntimeAsset>,
        emit: impl Fn(&EmbeddingRuntimeStatus) + Send + Sync + 'static,
    ) -> Self {
        Self {
            root,
            runtime,
            emit: Arc::new(emit),
            inner: Arc::new(Mutex::new(Inner::default())),
            install_lock: tokio::sync::Mutex::new(()),
            server_lock: tokio::sync::Mutex::new(()),
            verify_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self) -> EmbeddingRuntimeStatus {
        snapshot(&self.lock(), self.runtime.is_some())
    }

    fn publish(&self) -> EmbeddingRuntimeStatus {
        let status = self.snapshot();
        (self.emit)(&status);
        status
    }

    /// Kills the server synchronously. Called when the app exits.
    pub fn shutdown(&self) {
        let server = {
            let mut inner = self.lock();
            for token in [&inner.install_token, &inner.start_token]
                .into_iter()
                .flatten()
            {
                token.cancel();
            }
            inner.server.take()
        };
        drop(server);
    }

    async fn refresh(&self) -> Result<(), String> {
        let _verify = self.verify_lock.lock().await;
        let root = self.root.clone();
        let runtime = self.runtime;
        let mut cache = self.lock().verified.clone();
        let (installed, server_binary, disk_bytes, cache) = blocking(move || {
            let (installed, server) = scan_installed(&root, runtime, &mut cache);
            (installed, server, directory_size(&root), cache)
        })
        .await?;
        let mut inner = self.lock();
        inner.verified = cache;
        inner.installed = installed;
        inner.server_binary = server_binary;
        inner.disk_bytes = disk_bytes;
        Ok(())
    }

    pub async fn status(&self) -> Result<EmbeddingRuntimeStatus, String> {
        let (exited, installing) = {
            let mut inner = self.lock();
            (reap_exited(&mut inner), inner.installing)
        };
        drop(exited);
        // An install refreshes when it finishes; hashing its files mid-way
        // would only slow the download.
        if !installing {
            self.refresh().await?;
        }
        Ok(self.snapshot())
    }

    pub fn cancel(&self) {
        if let Some(token) = &self.lock().install_token {
            token.cancel();
        }
    }

    fn set_progress(&self, progress: Progress) {
        self.lock().progress = Some(progress);
        self.publish();
    }

    pub async fn install(&self, request: InstallRequest) -> Result<EmbeddingRuntimeStatus, String> {
        let runtime = self.runtime.ok_or(UNSUPPORTED)?;
        let Ok(_install) = self.install_lock.try_lock() else {
            return Err("The embedding files are already downloading".into());
        };
        let token = CancellationToken::new();
        {
            let mut inner = self.lock();
            inner.install_token = Some(token.clone());
            inner.installing = true;
            inner.progress = None;
            inner.error = None;
        }
        self.publish();
        let mut result = self.run_install(runtime, &request, &token).await;
        if let Err(error) = self.refresh().await {
            result = result.and(Err(error));
        }
        {
            let mut inner = self.lock();
            inner.install_token = None;
            inner.installing = false;
            inner.progress = None;
            if let Err(error) = &result {
                if error != CANCELLED {
                    inner.error = Some(error.clone());
                }
            }
        }
        let status = self.publish();
        result.map(|()| status)
    }

    async fn run_install(
        &self,
        runtime: RuntimeAsset,
        request: &InstallRequest,
        token: &CancellationToken,
    ) -> Result<(), String> {
        self.refresh().await?;
        let jobs = plan_jobs(&self.root, runtime, &self.lock().installed, request);
        if jobs.is_empty() {
            return Ok(());
        }
        let result = self.download_jobs(&jobs, token).await;
        if matches!(&result, Err(error) if error == CANCELLED) {
            for job in &jobs {
                match tokio::fs::remove_file(part_path(&job.destination)).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => log::warn!("Could not remove a cancelled download: {error}"),
                }
            }
        }
        result
    }

    async fn download_jobs(&self, jobs: &[Job], token: &CancellationToken) -> Result<(), String> {
        let client = download_client(true)?;
        let total: u64 = jobs.iter().map(|job| job.asset.bytes).sum();
        let mut completed = 0;
        for job in jobs {
            let mut last: Option<Instant> = None;
            download_verified(
                &client,
                &job.url,
                &job.destination,
                job.asset,
                token,
                |current| {
                    if current == job.asset.bytes
                        || last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL)
                    {
                        last = Some(Instant::now());
                        self.set_progress(Progress {
                            file: job.asset.file.into(),
                            downloaded_bytes: completed + current,
                            total_bytes: total,
                        });
                    }
                },
            )
            .await?;
            completed += job.asset.bytes;
            if let Some(kind) = job.archive {
                let root = self.root.clone();
                let archive = job.destination.clone();
                let sha256 = job.asset.sha256;
                blocking(move || {
                    install_runtime_archive(&root, &archive, kind, sha256)?;
                    let _ = fs::remove_file(&archive);
                    if let Some(downloads) = archive.parent() {
                        let _ = fs::remove_dir(downloads);
                    }
                    Ok::<(), String>(())
                })
                .await??;
            }
        }
        Ok(())
    }

    pub async fn start(&self, request: StartRequest) -> Result<EmbeddingRuntimeStatus, String> {
        self.runtime.ok_or(UNSUPPORTED)?;
        let context = clamp_context(request.context_size);
        let _server = self.server_lock.lock().await;
        let exited = reap_exited(&mut self.lock());
        drop(exited);
        let reusable = self.lock().server.as_ref().is_some_and(|server| {
            server.ready
                && server.info.quantization == request.quantization
                && (server.info.media || !request.media)
        });
        if reusable {
            return Ok(self.snapshot());
        }
        self.refresh().await?;
        let (binary, previous) = {
            let mut inner = self.lock();
            let ready = inner.installed.models.contains(&request.quantization)
                && (!request.media || inner.installed.media);
            match inner.server_binary.clone().filter(|_| ready) {
                Some(binary) => (binary, inner.server.take()),
                None => {
                    return Err(
                        "Download the embedding model before starting semantic search".into(),
                    )
                }
            }
        };
        drop(previous);
        let root = self.root.clone();
        blocking(move || reap_orphan(&root)).await?;
        let models = self.root.join(MODELS_DIR);
        let model = models.join(request.quantization.asset().file);
        let mmproj = request.media.then(|| models.join(MEDIA.file));

        let token = CancellationToken::new();
        {
            let mut inner = self.lock();
            inner.start_token = Some(token.clone());
            inner.starting = true;
            inner.error = None;
        }
        self.publish();
        // A port reserved with bind(0) can be taken before the server binds it.
        let mut attempts = 0;
        let result = loop {
            attempts += 1;
            let result = self
                .launch(
                    &binary,
                    &model,
                    mmproj.as_deref(),
                    request.quantization,
                    context,
                    &token,
                )
                .await;
            if attempts < 3 && matches!(result, Err(StartError::PortTaken)) {
                continue;
            }
            break result;
        };
        let launch = {
            let mut inner = self.lock();
            inner.start_token = None;
            inner.starting = false;
            match result {
                Ok(launch) => {
                    if let Some(server) = inner.server.as_mut() {
                        server.ready = true;
                    }
                    Ok(launch)
                }
                Err(error) => {
                    let cancelled = matches!(error, StartError::Cancelled);
                    let message = error.message();
                    if !cancelled {
                        inner.error = Some(message.clone());
                    }
                    Err(message)
                }
            }
        };
        if let Ok(launch) = launch {
            self.watch(launch);
        }
        let status = self.publish();
        launch.map(|_| status)
    }

    async fn launch(
        &self,
        binary: &Path,
        model: &Path,
        mmproj: Option<&Path>,
        quantization: Quantization,
        context: u32,
        token: &CancellationToken,
    ) -> Result<u64, StartError> {
        let port = free_port().map_err(StartError::Failed)?;
        let key = api_key().map_err(StartError::Failed)?;
        let mut child = server_command(binary, server_args(model, mmproj, context, port), &key)
            .spawn()
            .map_err(|error| {
                StartError::Failed(format!("Could not run the llama.cpp server: {error}"))
            })?;
        let logs = LogBuffer::default();
        capture(child.stdout.take(), &logs, &key);
        capture(child.stderr.take(), &logs, &key);
        let pidfile = write_pidfile(&self.root, child.id(), binary);
        let launch = {
            let mut inner = self.lock();
            inner.launch += 1;
            let launch = inner.launch;
            inner.server = Some(Server {
                child,
                info: RunningInfo {
                    endpoint: format!("http://127.0.0.1:{port}"),
                    api_key: key.clone(),
                    quantization,
                    media: mmproj.is_some(),
                },
                ready: false,
                launch,
                logs,
                pidfile,
            });
            launch
        };
        let result = self.wait_until_ready(launch, port, &key, token).await;
        if result.is_err() {
            let server = {
                let mut inner = self.lock();
                match &inner.server {
                    Some(server) if server.launch == launch => inner.server.take(),
                    _ => None,
                }
            };
            drop(server);
        }
        result.map(|()| launch)
    }

    fn launch_logs(&self, launch: u64) -> Vec<String> {
        let inner = self.lock();
        match &inner.server {
            Some(server) if server.launch == launch => server
                .logs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .cloned()
                .collect(),
            _ => Vec::new(),
        }
    }

    fn exited(&self, launch: u64) -> Option<StartError> {
        let mut inner = self.lock();
        let Some(server) = inner
            .server
            .as_mut()
            .filter(|server| server.launch == launch)
        else {
            return Some(StartError::Cancelled);
        };
        let exit = match server.child.try_wait() {
            Ok(None) => return None,
            Ok(Some(status)) => status.to_string(),
            Err(error) => error.to_string(),
        };
        // Let the log threads drain what the process wrote before it exited.
        drop(inner);
        std::thread::sleep(Duration::from_millis(50));
        let logs = self.launch_logs(launch);
        if logs.iter().any(|line| {
            let line = line.to_ascii_lowercase();
            line.contains("bind") || line.contains("address already in use")
        }) {
            return Some(StartError::PortTaken);
        }
        Some(StartError::Failed(start_failure(
            &format!("The embedding server exited before it was ready ({exit})"),
            &logs,
        )))
    }

    async fn wait_until_ready(
        &self,
        launch: u64,
        port: u16,
        key: &str,
        token: &CancellationToken,
    ) -> Result<(), StartError> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|_| StartError::Failed("Could not prepare the health check".into()))?;
        let url = format!("http://127.0.0.1:{port}/health");
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if let Some(failure) = self.exited(launch) {
                return Err(failure);
            }
            let healthy = async {
                let response = client.get(&url).bearer_auth(key).send().await.ok()?;
                if response.status() != StatusCode::OK {
                    return None;
                }
                let body: serde_json::Value = response.json().await.ok()?;
                (body["status"] == "ok").then_some(())
            };
            let healthy = tokio::select! {
                biased;
                _ = token.cancelled() => return Err(StartError::Cancelled),
                healthy = healthy => healthy.is_some(),
            };
            if healthy {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(StartError::Failed(start_failure(
                    "The embedding server did not become ready within 90 seconds",
                    &self.launch_logs(launch),
                )));
            }
            tokio::select! {
                biased;
                _ = token.cancelled() => return Err(StartError::Cancelled),
                _ = tokio::time::sleep(HEALTH_INTERVAL) => {}
            }
        }
    }

    /// Reports a crash of a running server without waiting for the next call.
    fn watch(&self, launch: u64) {
        let inner = self.inner.clone();
        let emit = self.emit.clone();
        let supported = self.runtime.is_some();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(WATCH_INTERVAL).await;
                let (exited, status) = {
                    let mut inner = inner.lock().unwrap_or_else(PoisonError::into_inner);
                    if !inner
                        .server
                        .as_ref()
                        .is_some_and(|server| server.launch == launch)
                    {
                        return;
                    }
                    let exited = reap_exited(&mut inner);
                    let status = exited.is_some().then(|| snapshot(&inner, supported));
                    (exited, status)
                };
                drop(exited);
                if let Some(status) = status {
                    emit(&status);
                    return;
                }
            }
        });
    }

    pub async fn stop(&self) -> EmbeddingRuntimeStatus {
        if let Some(token) = &self.lock().start_token {
            token.cancel();
        }
        let _server = self.server_lock.lock().await;
        let server = {
            let mut inner = self.lock();
            inner.error = None;
            inner.server.take()
        };
        drop(server);
        self.publish()
    }

    pub async fn remove(&self) -> Result<EmbeddingRuntimeStatus, String> {
        {
            let inner = self.lock();
            for token in [&inner.install_token, &inner.start_token]
                .into_iter()
                .flatten()
            {
                token.cancel();
            }
        }
        let _install = self.install_lock.lock().await;
        let _server = self.server_lock.lock().await;
        let _verify = self.verify_lock.lock().await;
        let server = self.lock().server.take();
        drop(server);
        let root = self.root.clone();
        let removed = blocking(move || match fs::remove_dir_all(&root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not remove the embedding files: {error}")),
        })
        .await?;
        let disk_bytes = directory_size(&self.root);
        {
            let mut inner = self.lock();
            inner.verified.clear();
            inner.installed = Installed::default();
            inner.server_binary = None;
            inner.disk_bytes = disk_bytes;
            inner.error = removed.as_ref().err().cloned();
        }
        let status = self.publish();
        removed.map(|()| status)
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
    use std::net::TcpListener;

    fn asset_for(bytes: &[u8]) -> Asset {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Asset {
            file: "fixture.bin",
            bytes: bytes.len() as u64,
            sha256: Box::leak(hex(&hasher.finalize()).into_boxed_str()),
        }
    }

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
        let request = InstallRequest {
            quantization: Quantization::Q4,
            media: true,
        };
        let jobs = plan_jobs(root, runtime, &Installed::default(), &request);
        assert_eq!(jobs.len(), 3);
        assert_eq!(
            jobs[0].url,
            "https://github.com/ggml-org/llama.cpp/releases/download/b11696/llama-b11696-bin-macos-arm64.tar.gz"
        );
        assert_eq!(jobs[0].archive, Some(ArchiveKind::TarGz));
        assert_eq!(
            jobs[1].url,
            "https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/031f0d4b35536f69ab3509d4893c923264fcf253/embeddinggemma-2-UD-Q4_K_XL.gguf"
        );
        assert_eq!(
            jobs[2].destination,
            root.join("models").join("mmproj-Q8_0.gguf")
        );
        let installed = Installed {
            runtime: true,
            models: vec![Quantization::Q4],
            media: false,
        };
        let jobs = plan_jobs(
            root,
            runtime,
            &installed,
            &InstallRequest {
                quantization: Quantization::Q8,
                media: false,
            },
        );
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].asset, Quantization::Q8.asset());
        assert!(plan_jobs(
            root,
            runtime,
            &installed,
            &InstallRequest {
                quantization: Quantization::Q4,
                media: false
            }
        )
        .is_empty());
    }

    #[test]
    fn archive_paths_reject_roots_drives_and_parent_components() {
        assert_eq!(
            sanitize_entry_path("llama-b11696/llama-server").unwrap(),
            Some(PathBuf::from("llama-b11696").join("llama-server"))
        );
        assert_eq!(
            sanitize_entry_path("./bin\\ggml.dll").unwrap(),
            Some(PathBuf::from("bin").join("ggml.dll"))
        );
        assert_eq!(sanitize_entry_path("./").unwrap(), None);
        for unsafe_path in [
            "../evil",
            "llama/../../evil",
            "..\\evil.dll",
            "a\\..\\..\\b",
            "/etc/passwd",
            "\\\\server\\share\\x",
            "C:\\Windows\\evil.dll",
            "C:evil",
            "llama-server.exe:stream",
            "nul\0byte",
        ] {
            assert!(
                sanitize_entry_path(unsafe_path).is_err(),
                "{unsafe_path} must be rejected"
            );
        }
    }

    #[test]
    fn zip_slip_entries_abort_extraction_without_writing_outside() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("evil.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("llama-server.exe", options).unwrap();
        writer.write_all(b"binary").unwrap();
        writer.start_file("../escaped.txt", options).unwrap();
        writer.write_all(b"escaped").unwrap();
        writer.finish().unwrap();
        let root = directory.path().join("root");
        let error = install_runtime_archive(&root, &archive, ArchiveKind::Zip, "00").unwrap_err();
        assert_eq!(error, UNSAFE_ARCHIVE);
        assert!(!directory.path().join("escaped.txt").exists());
        assert!(!root.join(RUNTIME_DIR).exists());
        // The staging directory is removed with the failed extraction.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    }

    #[test]
    fn flat_zip_archives_extract_without_a_top_level_folder() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("flat.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file(SERVER_BINARY, options).unwrap();
        writer.write_all(b"server").unwrap();
        writer.start_file("ggml.dll", options).unwrap();
        writer.write_all(b"library").unwrap();
        writer.finish().unwrap();
        let root = directory.path().join("root");
        let sha256 = sha256_file(&archive).unwrap();
        install_runtime_archive(&root, &archive, ArchiveKind::Zip, &sha256).unwrap();
        let marker = read_marker(&root.join(RUNTIME_DIR).join(RUNTIME_MARKER)).unwrap();
        assert_eq!(marker.server, SERVER_BINARY);
        assert_eq!(
            fs::read(root.join(RUNTIME_DIR).join("ggml.dll")).unwrap(),
            b"library"
        );
    }

    #[test]
    fn archive_links_must_name_a_sibling_file() {
        let link = Path::new("llama/libllama.dylib");
        assert_eq!(
            sibling_link_target(link, "libllama.0.dylib"),
            Some(PathBuf::from("llama/libllama.0.dylib"))
        );
        for target in [
            "",
            ".",
            "..",
            "../libllama.dylib",
            "/usr/lib/libc.dylib",
            "sub/lib",
            "C:lib",
            "a\\b",
        ] {
            assert_eq!(sibling_link_target(link, target), None, "{target}");
        }

        let mut files = BTreeMap::new();
        files.insert(
            PathBuf::from("llama/libllama.0.7.0.dylib"),
            MarkerFile {
                path: "llama/libllama.0.7.0.dylib".into(),
                bytes: 1,
                sha256: String::new(),
            },
        );
        let links: HashMap<PathBuf, String> = [
            ("llama/libllama.dylib", "libllama.0.dylib"),
            ("llama/libllama.0.dylib", "libllama.0.7.0.dylib"),
            ("llama/loop-a", "loop-b"),
            ("llama/loop-b", "loop-a"),
            ("llama/dangling", "missing.dylib"),
            ("llama/escape", "../outside"),
        ]
        .into_iter()
        .map(|(link, target)| (PathBuf::from(link), target.to_string()))
        .collect();
        assert_eq!(
            resolve_link(Path::new("llama/libllama.dylib"), &links, &files),
            Some(PathBuf::from("llama/libllama.0.7.0.dylib"))
        );
        for unresolved in ["llama/loop-a", "llama/dangling", "llama/escape"] {
            assert_eq!(resolve_link(Path::new(unresolved), &links, &files), None);
        }
    }

    fn tar_gz_fixture(path: &Path) {
        let encoder =
            flate2::write::GzEncoder::new(File::create(path).unwrap(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut add_file = |name: &str, mode: u32, data: &[u8]| {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(mode);
            header.set_entry_type(tar::EntryType::Regular);
            builder.append_data(&mut header, name, data).unwrap();
        };
        add_file(
            &format!("llama-b11696/{SERVER_BINARY}"),
            0o755,
            b"#!/bin/sh\n",
        );
        add_file("llama-b11696/libllama.0.7.0.dylib", 0o755, b"library");
        add_file("llama-b11696/LICENSE", 0o644, b"MIT");
        let mut add_link = |name: &str, target: &str| {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            builder
                .append_link(&mut header, name, target)
                .unwrap_or_else(|_| {
                    // append_link refuses unsafe targets; write them raw.
                    header.set_link_name_literal(target).unwrap();
                    header.set_path(name).unwrap();
                    header.set_cksum();
                    builder.append(&header, io::empty()).unwrap();
                });
        };
        add_link("llama-b11696/libllama.dylib", "libllama.0.dylib");
        add_link("llama-b11696/libllama.0.dylib", "libllama.0.7.0.dylib");
        add_link("llama-b11696/passwd", "/etc/passwd");
        add_link("llama-b11696/parent", "../LICENSE");
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn tar_runtime_flattens_its_folder_keeps_exec_bits_and_only_safe_links() {
        let directory = tempfile::tempdir().unwrap();
        let archive = directory.path().join("runtime.tar.gz");
        tar_gz_fixture(&archive);
        let sha256 = sha256_file(&archive).unwrap();
        let root = directory.path().join("root");
        install_runtime_archive(&root, &archive, ArchiveKind::TarGz, &sha256).unwrap();
        let runtime = root.join(RUNTIME_DIR);
        assert!(runtime.join("LICENSE").is_file());
        assert!(!runtime.join("llama-b11696").exists());
        assert_eq!(
            fs::read(runtime.join("libllama.dylib")).unwrap(),
            b"library"
        );
        assert_eq!(
            fs::read(runtime.join("libllama.0.dylib")).unwrap(),
            b"library"
        );
        assert!(fs::symlink_metadata(runtime.join("passwd")).is_err());
        assert!(fs::symlink_metadata(runtime.join("parent")).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |name: &str| {
                fs::metadata(runtime.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode(SERVER_BINARY), 0o755);
            assert_eq!(mode("LICENSE"), 0o644);
            assert_eq!(
                fs::read_link(runtime.join("libllama.dylib")).unwrap(),
                PathBuf::from("libllama.0.7.0.dylib")
            );
        }
        // Remaining staging folders are cleaned up beside the runtime.
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);

        let pinned = RuntimeAsset {
            asset: Asset {
                file: "runtime.tar.gz",
                bytes: 0,
                sha256: Box::leak(sha256.into_boxed_str()),
            },
            kind: ArchiveKind::TarGz,
        };
        let mut cache = VerifyCache::new();
        assert_eq!(
            verified_server(&root, pinned, &mut cache),
            Some(runtime.join(SERVER_BINARY))
        );
        let other = RuntimeAsset {
            asset: Asset {
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                ..pinned.asset
            },
            ..pinned
        };
        assert_eq!(verified_server(&root, other, &mut VerifyCache::new()), None);
        // Same-size tampering is caught once the file's stamp changes.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(runtime.join("LICENSE"), b"BSD").unwrap();
        assert_eq!(verified_server(&root, pinned, &mut cache), None);
    }

    #[test]
    fn sha256_verification_checks_size_and_digest_and_caches_by_stamp() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("model.gguf");
        fs::write(&path, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_file(&path).unwrap(), abc);
        let mut cache = VerifyCache::new();
        assert!(verify_file(&mut cache, &path, 3, abc));
        assert!(verify_file(&mut cache, &path, 3, &abc.to_ascii_uppercase()));
        assert!(!verify_file(&mut cache, &path, 4, abc));
        assert!(!verify_file(
            &mut cache,
            &directory.path().join("missing"),
            3,
            abc
        ));
        assert!(!verify_file(
            &mut VerifyCache::new(),
            &path,
            3,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ae"
        ));
        assert_eq!(cache.len(), 1);
        assert!(cache[&path].1);
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
            error: None,
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
        assert!(json.get("error").is_none());

        let idle = snapshot(&Inner::default(), true);
        let json = serde_json::to_value(&idle).unwrap();
        assert_eq!(json["state"], "idle");
        assert!(json.get("running").is_none() && json.get("progress").is_none());
        assert_eq!(
            serde_json::to_value(snapshot(&Inner::default(), false)).unwrap()["state"],
            "unsupported"
        );
        let failed = Inner {
            error: Some("broken".into()),
            ..Inner::default()
        };
        let json = serde_json::to_value(snapshot(&failed, true)).unwrap();
        assert_eq!(
            (json["state"].as_str(), json["error"].as_str()),
            (Some("error"), Some("broken"))
        );
        let downloading = Inner {
            installing: true,
            ..Inner::default()
        };
        assert_eq!(
            snapshot(&downloading, true).state,
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
        let key = api_key().unwrap();
        assert_eq!(key.len(), 64);
        assert_ne!(key, api_key().unwrap());
    }

    #[test]
    fn start_failures_surface_the_most_relevant_server_line() {
        let logs = vec![
            "load_model: loading model".to_string(),
            "llama_model_load: error loading model: tensor data is not within bounds".to_string(),
            "main: exiting due to model loading error".to_string(),
        ];
        assert_eq!(
            start_failure("The server exited", &logs),
            "The server exited: main: exiting due to model loading error"
        );
        assert_eq!(start_failure("Timed out", &[]), "Timed out");
        assert_eq!(
            start_failure("Exited", &["just a line".to_string()]),
            "Exited: just a line"
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_a_crashed_ready_server_is_reaped_and_reported() {
        let server = |ready: bool| Server {
            child: Command::new("sh").args(["-c", "exit 3"]).spawn().unwrap(),
            info: RunningInfo {
                endpoint: "http://127.0.0.1:1".into(),
                api_key: "key".into(),
                quantization: Quantization::Q4,
                media: false,
            },
            ready,
            launch: 1,
            logs: Arc::new(Mutex::new(VecDeque::from([
                "error: out of memory".to_string()
            ]))),
            pidfile: None,
        };
        let mut inner = Inner {
            server: Some(server(false)),
            ..Inner::default()
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(reap_exited(&mut inner).is_none());
        assert!(inner.server.is_some());

        inner.server = Some(server(true));
        std::thread::sleep(Duration::from_millis(200));
        assert!(reap_exited(&mut inner).is_some());
        assert!(inner.server.is_none());
        let status = snapshot(&inner, true);
        assert_eq!(status.state, RuntimeState::Error);
        let error = status.error.unwrap();
        assert!(error.contains("stopped unexpectedly"), "{error}");
        assert!(error.ends_with("error: out of memory"), "{error}");
    }

    fn pid_record(pid: u32, owner: u32, path: PathBuf) -> PidRecord {
        PidRecord {
            pid,
            owner,
            path,
            started_at: 1_760_000_000,
        }
    }

    #[test]
    fn pidfiles_parse_only_complete_absolute_records() {
        let path = std::env::temp_dir().join(RUNTIME_DIR).join(SERVER_BINARY);
        let record = pid_record(4242, 17, path.clone());
        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains("\"startedAt\":1760000000"));
        assert_eq!(parse_pidfile(&json), Some(record.clone()));
        let reject = |record: PidRecord| parse_pidfile(&serde_json::to_string(&record).unwrap());
        assert_eq!(reject(pid_record(0, 17, path.clone())), None);
        assert_eq!(
            reject(pid_record(std::process::id(), 17, path.clone())),
            None
        );
        assert_eq!(
            reject(pid_record(4242, 17, PathBuf::from(SERVER_BINARY))),
            None
        );
        assert_eq!(parse_pidfile(r#"{"pid":4242,"owner":17}"#), None);
        assert_eq!(parse_pidfile("4242"), None);
        assert_eq!(parse_pidfile(""), None);
    }

    #[test]
    fn orphans_are_terminated_only_when_their_live_executable_is_ours() {
        let runtime = std::env::temp_dir().join("embedding").join(RUNTIME_DIR);
        let ours = runtime.join(SERVER_BINARY);
        let record = pid_record(4242, 17, ours.clone());
        assert_eq!(
            orphan_action(&record, &runtime, Some(&ours), false),
            OrphanAction::Terminate
        );
        // Exited, or still owned by a running TypeNext.
        assert_eq!(
            orphan_action(&record, &runtime, None, false),
            OrphanAction::Discard
        );
        assert_eq!(
            orphan_action(&record, &runtime, Some(&ours), true),
            OrphanAction::Keep
        );
        // The pid was reused by an unrelated program.
        let unrelated = std::env::temp_dir().join("bin").join("editor");
        assert_eq!(
            orphan_action(&record, &runtime, Some(&unrelated), false),
            OrphanAction::Discard
        );
        // Records that do not name our managed server are never acted on, even
        // when the live path agrees with them.
        for path in [
            std::env::temp_dir().join("other").join(SERVER_BINARY),
            runtime.join("llama-cli"),
            runtime.join("..").join("elsewhere").join(SERVER_BINARY),
        ] {
            let forged = pid_record(4242, 17, path.clone());
            assert_eq!(
                orphan_action(&forged, &runtime, Some(&path), false),
                OrphanAction::Discard,
                "{}",
                path.display()
            );
        }
    }

    #[test]
    fn pidfiles_are_removed_only_for_the_process_they_describe() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join(SERVER_BINARY);
        fs::write(&binary, b"").unwrap();
        let path = write_pidfile(directory.path(), 4242, &binary).unwrap();
        let record = read_pidfile(&path).unwrap();
        assert_eq!(record.owner, std::process::id());
        assert_eq!(record.path, normalize(&binary));
        assert!(record.started_at > 0);
        remove_pidfile_for(&path, 999);
        assert!(path.exists());
        remove_pidfile_for(&path, 4242);
        assert!(!path.exists());
        // An unreadable record is cleared without signalling anything.
        fs::write(&path, b"not json").unwrap();
        reap_orphan(directory.path());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "helper process for reaping_kills_only_an_orphaned_managed_server"]
    fn orphan_fixture_child() {
        if std::env::var_os("TYPENEXT_ORPHAN_FIXTURE").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    #[cfg(unix)]
    #[test]
    fn reaping_kills_only_an_orphaned_managed_server() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("embedding");
        let runtime = root.join(RUNTIME_DIR);
        let elsewhere = directory.path().join("elsewhere");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let managed = runtime.join(SERVER_BINARY);
        let unrelated = elsewhere.join(SERVER_BINARY);
        // System binaries cannot run from a copy on macOS, so the fixture is a
        // copy of this test executable running the idle helper below.
        let test_binary = std::env::current_exe().unwrap();
        fs::copy(&test_binary, &managed).unwrap();
        fs::copy(&test_binary, &unrelated).unwrap();
        // Background processes started by a shell that exits are reparented to
        // init/launchd, exactly like a server whose app crashed.
        let orphan = |binary: &Path| -> u32 {
            let output = Command::new("sh")
                .args([
                    "-c",
                    "\"$0\" --exact embedding::tests::orphan_fixture_child --ignored >/dev/null 2>&1 & echo $!",
                ])
                .arg(binary)
                .env("TYPENEXT_ORPHAN_FIXTURE", "1")
                .output()
                .unwrap();
            let pid = String::from_utf8(output.stdout)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while process_path(pid).map(|path| normalize(&path)) != Some(normalize(binary)) {
                assert!(
                    Instant::now() < deadline,
                    "the fixture process did not start"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            pid
        };
        let dead_owner = {
            let mut child = Command::new("true").spawn().unwrap();
            let pid = child.id();
            child.wait().unwrap();
            pid
        };
        let pidfile = root.join(PIDFILE);
        let record = |pid: u32, owner: u32| {
            let record = pid_record(pid, owner, normalize(&managed));
            fs::write(&pidfile, serde_json::to_vec(&record).unwrap()).unwrap();
        };
        let alive = |pid: u32| process_path(pid).is_some();
        let server = orphan(&managed);
        let stranger = orphan(&unrelated);

        // A record pointing at a process that is not our server is dropped.
        record(stranger, dead_owner);
        reap_orphan(&root);
        assert!(alive(stranger));
        assert!(!pidfile.exists());

        // A server whose TypeNext is still running is left alone.
        record(server, std::process::id());
        reap_orphan(&root);
        assert!(alive(server));
        assert!(pidfile.exists());

        // An orphaned managed server is stopped and its record removed.
        record(server, dead_owner);
        reap_orphan(&root);
        assert!(!alive(server));
        assert!(!pidfile.exists());

        // SAFETY: stranger is the fixture process verified above.
        unsafe { libc::kill(stranger as libc::pid_t, libc::SIGKILL) };
    }

    /// Serves `body` to each connection, honoring `Range: bytes=N-` when
    /// `ranges` is set. Returns the base URL and the received request heads.
    fn file_server(
        body: Vec<u8>,
        connections: usize,
        ranges: bool,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for _ in 0..connections {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
                let start = head
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="))
                    .and_then(|range| range.trim_end_matches('-').parse::<usize>().ok())
                    .filter(|_| ranges);
                seen.lock().unwrap().push(head);
                let response = match start {
                    Some(start) => {
                        let mut response = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\nConnection: close\r\n\r\n",
                            body.len() - start,
                            body.len() - 1,
                            body.len()
                        )
                        .into_bytes();
                        response.extend_from_slice(&body[start..]);
                        response
                    }
                    None => {
                        let mut response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        response.extend_from_slice(&body);
                        response
                    }
                };
                let _ = stream.write_all(&response);
            }
        });
        (format!("http://{address}/fixture.bin"), requests)
    }

    #[tokio::test]
    async fn downloads_verify_before_rename_and_resume_partial_files() {
        let body: Vec<u8> = (0..200_000u32).map(|value| (value % 251) as u8).collect();
        let asset = asset_for(&body);
        let client = download_client(false).unwrap();
        let token = CancellationToken::new();
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("models").join("fixture.bin");

        // A partial file resumes with a range request.
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(part_path(&destination), &body[..70_000]).unwrap();
        let (url, requests) = file_server(body.clone(), 1, true);
        let mut reported = Vec::new();
        download_verified(&client, &url, &destination, asset, &token, |bytes| {
            reported.push(bytes)
        })
        .await
        .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), body);
        assert!(!part_path(&destination).exists());
        assert!(requests.lock().unwrap()[0].contains("range: bytes=70000-"));
        assert_eq!(reported.first(), Some(&70_000));
        assert_eq!(reported.last(), Some(&(body.len() as u64)));

        // A verified file is not downloaded again.
        download_verified(
            &client,
            "http://127.0.0.1:9/unused",
            &destination,
            asset,
            &token,
            |_| {},
        )
        .await
        .unwrap();

        // A server that ignores the range restarts the file from zero.
        fs::remove_file(&destination).unwrap();
        fs::write(part_path(&destination), &body[..1_000]).unwrap();
        let (url, _) = file_server(body.clone(), 1, false);
        download_verified(&client, &url, &destination, asset, &token, |_| {})
            .await
            .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), body);

        // Corrupt content is discarded and never renamed into place.
        fs::remove_file(&destination).unwrap();
        let mut corrupt = body.clone();
        corrupt[123] ^= 0xff;
        let (url, _) = file_server(corrupt, 1, false);
        let error = download_verified(&client, &url, &destination, asset, &token, |_| {})
            .await
            .unwrap_err();
        assert!(error.contains("SHA-256"), "{error}");
        assert!(!destination.exists());
        assert!(!part_path(&destination).exists());
    }

    #[tokio::test]
    async fn cancelled_downloads_stop_before_completing() {
        let body = vec![7; 1024];
        let asset = asset_for(&body);
        let token = CancellationToken::new();
        token.cancel();
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("fixture.bin");
        let (url, _) = file_server(body, 1, false);
        let error = download_verified(
            &download_client(false).unwrap(),
            &url,
            &destination,
            asset,
            &token,
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error, CANCELLED);
        assert!(!destination.exists());
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
        install_runtime_archive(&root, &downloads, runtime.kind, runtime.asset.sha256).unwrap();
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

        let endpoint = state.snapshot().running.unwrap().endpoint;
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
        let endpoint = state.snapshot().running.unwrap().endpoint;
        drop(state);
        assert!(client
            .get(format!("{endpoint}/health"))
            .send()
            .await
            .is_err());
    }
}
