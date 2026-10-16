//! Shared machinery for the managed local runtimes (embeddings and speech):
//! pinned downloads verified with SHA-256, safe archive extraction, a private
//! loopback server process with orphan cleanup, and the install/start/stop
//! state machine that reports its status to the frontend.

use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
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
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

pub(crate) const MODELS_DIR: &str = "models";
pub(crate) const DOWNLOADS_DIR: &str = "downloads";
pub(crate) const RUNTIME_MARKER: &str = ".typenext-runtime.json";
pub(crate) const CANCELLED: &str = "Download cancelled";
pub(crate) const HUGGING_FACE_AUTH: &str = "huggingface-auth";
pub(crate) const HUGGING_FACE_RATE_LIMIT: &str = "huggingface-rate-limit";
const HUGGING_FACE_AUTH_MESSAGE: &str = "Hugging Face asks for a sign-in token for this model.";
const HUGGING_FACE_RATE_MESSAGE: &str =
    "Hugging Face is limiting anonymous downloads. Add a token to continue.";
const MAX_PIDFILE_BYTES: u64 = 16 * 1024;
const MAX_MARKER_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 4096;
const START_TIMEOUT: Duration = Duration::from_secs(90);
const HEALTH_INTERVAL: Duration = Duration::from_millis(250);
const WATCH_INTERVAL: Duration = Duration::from_secs(2);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const LOG_LINES: usize = 40;
const LOG_LINE_BYTES: u64 = 4096;
const LOG_LINE_CHARS: usize = 400;
pub(crate) const UNSAFE_ARCHIVE: &str =
    "The runtime archive contains an unsafe path and was not installed";

/// What differs between the managed runtimes on disk and in messages.
#[derive(Debug)]
pub(crate) struct Layout {
    pub release: &'static str,
    pub runtime_dir: &'static str,
    /// The server executable, including `.exe` on Windows.
    pub binary: &'static str,
    pub pidfile: &'static str,
    /// For messages, such as "embedding server".
    pub server: &'static str,
    /// For messages, such as "managed embedding runtime".
    pub runtime: &'static str,
    /// Environment prefixes cleared before the server starts.
    pub clear_env: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Asset {
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuntimeAsset {
    pub asset: Asset,
    pub kind: ArchiveKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RuntimeState {
    Unsupported,
    Idle,
    Downloading,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    pub file: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// A failed operation with an optional machine-readable code for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Failure {
    pub message: String,
    pub code: Option<&'static str>,
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

// Verification -------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

/// Per-session SHA-256 results, keyed by path and invalidated when the file's
/// size or modification time changes.
pub(crate) type VerifyCache = HashMap<PathBuf, (Stamp, bool)>;

pub(crate) fn hex(bytes: &[u8]) -> String {
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

pub(crate) fn sha256_file(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    hash_into(&mut File::open(path)?, &mut hasher)?;
    Ok(hex(&hasher.finalize()))
}

pub(crate) fn verify_file(cache: &mut VerifyCache, path: &Path, bytes: u64, sha256: &str) -> bool {
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
pub(crate) struct RuntimeMarker {
    pub release: String,
    pub archive_sha256: String,
    pub server: String,
    pub files: Vec<MarkerFile>,
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct MarkerFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

pub(crate) fn read_marker(path: &Path) -> Option<RuntimeMarker> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_MARKER_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The extracted runtime is trusted only when its marker names the pinned
/// archive and every extracted file still matches the hash recorded at
/// extraction time.
pub(crate) fn verified_server(
    root: &Path,
    layout: &Layout,
    runtime: RuntimeAsset,
    cache: &mut VerifyCache,
) -> Option<PathBuf> {
    let directory = root.join(layout.runtime_dir);
    let marker = read_marker(&directory.join(RUNTIME_MARKER))?;
    if marker.release != layout.release
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

pub(crate) fn directory_size(path: &Path) -> u64 {
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
pub(crate) fn sanitize_entry_path(raw: &str) -> Result<Option<PathBuf>, String> {
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
pub(crate) fn sibling_link_target(link: &Path, target: &str) -> Option<PathBuf> {
    let plain = !target.is_empty()
        && target != "."
        && target != ".."
        && !target.contains(['/', '\\', ':', '\0']);
    plain.then(|| link.parent().unwrap_or(Path::new("")).join(target))
}

/// Follows a chain of sibling links to the regular file it ends at.
pub(crate) fn resolve_link(
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

/// The single folder every entry shares, such as `llama-b11696/`. Some
/// Windows archives have no top-level folder.
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
    format!("Could not extract the runtime: {error}")
}

#[cfg(unix)]
fn unix_permissions(relative: &Path, mode: Option<u32>, binary: &str) -> u32 {
    let executable = mode.is_some_and(|mode| mode & 0o111 != 0)
        || relative.file_name().is_some_and(|name| name == binary);
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
    binary: &str,
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
            fs::Permissions::from_mode(unix_permissions(&relative, mode, binary)),
        )
        .map_err(archive_error)?;
    }
    #[cfg(not(unix))]
    let _ = (mode, binary);
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

fn extract_tar_gz(archive: &Path, staging: &Path, binary: &str) -> Result<Extracted, String> {
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
            write_entry(staging, relative, &mut entry, mode, binary, &mut extracted)?;
        } else if kind.is_symlink() {
            let target = match entry.link_name_bytes() {
                Some(target) => utf8_name(&target)?,
                None => String::new(),
            };
            extracted.files.remove(&relative);
            extracted.links.insert(relative, target);
        } else {
            log::warn!("Skipping an unsupported runtime archive entry: {raw}");
        }
    }
    Ok(extracted)
}

fn extract_zip(archive: &Path, staging: &Path, binary: &str) -> Result<Extracted, String> {
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
            write_entry(staging, relative, &mut entry, mode, binary, &mut extracted)?;
        } else {
            log::warn!("Skipping an unsupported runtime archive entry: {raw}");
        }
    }
    Ok(extracted)
}

/// Extracts a verified archive beside the final directory, records a hash
/// manifest and swaps the complete directory into place.
pub(crate) fn install_runtime_archive(
    root: &Path,
    layout: &Layout,
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
        ArchiveKind::TarGz => extract_tar_gz(archive, staging.path(), layout.binary)?,
        ArchiveKind::Zip => extract_zip(archive, staging.path(), layout.binary)?,
    };

    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut links = Vec::new();
    let mut link_paths: Vec<_> = extracted.links.keys().cloned().collect();
    link_paths.sort();
    for link in link_paths {
        let Some(resolved) = resolve_link(&link, &extracted.links, &extracted.files) else {
            log::warn!(
                "Skipping an unsafe or dangling runtime archive link: {}",
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
        .filter(|file| file.path.rsplit('/').next() == Some(layout.binary))
        .min_by_key(|file| file.path.matches('/').count())
        .map(|file| file.path.clone())
        .ok_or_else(|| archive_error(format!("{} is missing", layout.binary)))?;
    let marker = RuntimeMarker {
        release: layout.release.into(),
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

    let destination = root.join(layout.runtime_dir);
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
pub(crate) struct Job {
    pub asset: Asset,
    pub url: String,
    pub destination: PathBuf,
    pub archive: Option<ArchiveKind>,
    /// Hugging Face URLs may carry the writer's token and map refusals to
    /// error codes the frontend explains.
    pub hugging_face: bool,
    pub auth: Option<HeaderValue>,
}

impl Job {
    pub fn runtime(root: &Path, base_url: &str, runtime: RuntimeAsset) -> Self {
        Self::new(
            runtime.asset,
            format!("{base_url}{}", runtime.asset.file),
            root.join(DOWNLOADS_DIR).join(runtime.asset.file),
            Some(runtime.kind),
        )
    }

    pub fn model(root: &Path, base_url: &str, asset: Asset) -> Self {
        Self::new(
            asset,
            format!("{base_url}{}", asset.file),
            root.join(MODELS_DIR).join(asset.file),
            None,
        )
    }

    fn new(asset: Asset, url: String, destination: PathBuf, archive: Option<ArchiveKind>) -> Self {
        Self {
            hugging_face: is_hugging_face(&url),
            asset,
            url,
            destination,
            archive,
            auth: None,
        }
    }
}

pub(crate) fn is_hugging_face(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| {
                let host = host.to_ascii_lowercase();
                host == "huggingface.co" || host.ends_with(".huggingface.co")
            })
    })
}

/// The optional Hugging Face token as a sensitive header value. It is only
/// attached to huggingface.co requests; reqwest drops Authorization whenever
/// a redirect changes host or port, so CDN redirect targets never see it.
pub(crate) fn hugging_face_auth(token: Option<&str>) -> Result<Option<HeaderValue>, String> {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
        return Ok(None);
    };
    let invalid = || "The Hugging Face token is not valid. Paste it again in Preferences.";
    if token.len() > MAX_TOKEN_BYTES || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(invalid().into());
    }
    let mut value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| invalid())?;
    value.set_sensitive(true);
    Ok(Some(value))
}

pub(crate) fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    destination.with_file_name(name)
}

/// GitHub and Hugging Face both redirect to CDNs. Unlike the provider client
/// in http.rs, this client follows HTTPS redirects, and it leaves bodies
/// undecoded so hashes see the exact bytes.
pub(crate) fn download_client(https_only: bool) -> Result<Client, String> {
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
        // Never expose the CDN URL, its signed query or a token.
        "The download was interrupted. Try again to resume it.".into()
    }
}

fn io_error(error: io::Error) -> String {
    format!("Could not save the downloaded files: {error}")
}

fn content_range_starts_at(response: &reqwest::Response, offset: u64) -> bool {
    response
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with(&format!("bytes {offset}-")))
}

/// Hugging Face refusals the frontend can explain, only when huggingface.co
/// itself answered (not a CDN it redirected to).
fn hugging_face_refusal(job: &Job, response: &reqwest::Response) -> Option<Failure> {
    let original = Url::parse(&job.url).ok()?;
    if !job.hugging_face || response.url().host_str() != original.host_str() {
        return None;
    }
    let (message, code) = match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            (HUGGING_FACE_AUTH_MESSAGE, HUGGING_FACE_AUTH)
        }
        StatusCode::TOO_MANY_REQUESTS => (HUGGING_FACE_RATE_MESSAGE, HUGGING_FACE_RATE_LIMIT),
        _ => return None,
    };
    Some(Failure {
        message: message.into(),
        code: Some(code),
    })
}

pub(crate) async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| "The runtime task stopped unexpectedly".to_string())
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
pub(crate) async fn download_verified(
    client: &Client,
    job: &Job,
    token: &CancellationToken,
    mut progress: impl FnMut(u64),
) -> Result<(), Failure> {
    let asset = job.asset;
    let destination = job.destination.as_path();
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
        let mut request = client.get(&job.url);
        if let Some(auth) = job.auth.clone().filter(|_| job.hugging_face) {
            request = request.header(AUTHORIZATION, auth);
        }
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let mut response = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(CANCELLED.into()),
            response = request.send() => response.map_err(download_error)?,
        };
        if let Some(refusal) = hugging_face_refusal(job, &response) {
            return Err(refusal);
        }
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
                )
                .into());
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
            )
            .into());
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
                return Err(format!("{} is larger than the pinned file", asset.file).into());
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
        )
        .into());
    }
    tokio::fs::rename(&part, destination)
        .await
        .map_err(io_error)?;
    Ok(())
}

// Server process -----------------------------------------------------------

type LogBuffer = Arc<Mutex<VecDeque<String>>>;

pub(crate) struct Server<R> {
    child: Child,
    info: R,
    ready: bool,
    launch: u64,
    logs: LogBuffer,
    pidfile: Option<PathBuf>,
}

impl<R> Drop for Server<R> {
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

impl<R> Server<R> {
    fn log_lines(&self) -> Vec<String> {
        self.logs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

/// How one server process is launched.
pub(crate) struct LaunchSpec<R> {
    pub args: Vec<OsString>,
    pub env: Vec<(&'static str, String)>,
    /// Sent as a Bearer token to /health and redacted from captured output.
    pub secret: Option<String>,
    pub running: R,
}

fn server_command(
    binary: &Path,
    layout: &Layout,
    args: Vec<OsString>,
    env: Vec<(&'static str, String)>,
) -> Command {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Inherited variables such as LLAMA_ARG_HOST could reconfigure the server.
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if layout
            .clear_env
            .iter()
            .any(|prefix| text.starts_with(prefix))
        {
            command.env_remove(name);
        }
    }
    // Secrets travel in the environment so other local users cannot read
    // them from the process list.
    command.envs(env);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn capture(pipe: Option<impl Read + Send + 'static>, logs: &LogBuffer, secret: Option<&str>) {
    let Some(pipe) = pipe else {
        return;
    };
    let logs = logs.clone();
    let secret = secret
        .filter(|secret| !secret.is_empty())
        .map(str::to_owned);
    // The pipes are drained for the server's whole life so it never blocks on
    // a full buffer. Each thread ends when the process closes its output.
    let spawned = std::thread::Builder::new()
        .name("runtime-server-log".into())
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
                let mut text = String::from_utf8_lossy(&line).into_owned();
                if let Some(secret) = &secret {
                    text = text.replace(secret.as_str(), "<redacted>");
                }
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
        log::warn!("Could not capture the runtime server output: {error}");
    }
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("Could not reserve a local port for the server: {error}"))
}

pub(crate) fn random_key() -> Result<String, String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not generate a server key".to_string())?;
    Ok(hex(&bytes))
}

pub(crate) fn start_failure(reason: &str, logs: &[String]) -> String {
    if !logs.is_empty() {
        log::warn!("Server output before failure:\n{}", logs.join("\n"));
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

// Orphan cleanup -------------------------------------------------------------

/// Written beside the runtime while a server runs so a server orphaned by a
/// crash or force-quit can be found and stopped on the next launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PidRecord {
    pub pid: u32,
    /// The TypeNext process that launched the server.
    pub owner: u32,
    pub path: PathBuf,
    pub started_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrphanAction {
    /// Its owner is still running, as with a second TypeNext window.
    Keep,
    /// Stale record: the process is gone or is not our server.
    Discard,
    Terminate,
}

pub(crate) fn parse_pidfile(text: &str) -> Option<PidRecord> {
    let record: PidRecord = serde_json::from_str(text).ok()?;
    (record.pid != 0 && record.pid != std::process::id() && record.path.is_absolute())
        .then_some(record)
}

/// Paths must already be normalized. A process is only ever terminated when
/// its live executable is the managed server recorded for it.
pub(crate) fn orphan_action(
    record: &PidRecord,
    runtime_dir: &Path,
    binary: &str,
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
        && record.path.file_name().is_some_and(|name| name == binary);
    if managed && live_path == record.path {
        OrphanAction::Terminate
    } else {
        OrphanAction::Discard
    }
}

pub(crate) fn normalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(crate) fn write_pidfile(root: &Path, name: &str, pid: u32, binary: &Path) -> Option<PathBuf> {
    let record = PidRecord {
        pid,
        owner: std::process::id(),
        path: normalize(binary),
        started_at: unix_time(),
    };
    let path = root.join(name);
    let written = serde_json::to_vec(&record)
        .map_err(io::Error::other)
        .and_then(|bytes| {
            let mut file = tempfile::Builder::new()
                .prefix(".server.pid-")
                .tempfile_in(root)?;
            file.write_all(&bytes)?;
            file.persist(&path).map_err(|error| error.error)?;
            Ok(())
        });
    match written {
        Ok(()) => Some(path),
        Err(error) => {
            log::warn!("Could not record the runtime server process: {error}");
            None
        }
    }
}

pub(crate) fn read_pidfile(path: &Path) -> Option<PidRecord> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PIDFILE_BYTES {
        return None;
    }
    parse_pidfile(&fs::read_to_string(path).ok()?)
}

/// Removes the pidfile only while it still describes `pid`, so a newer
/// server's record survives an older server being dropped.
pub(crate) fn remove_pidfile_for(path: &Path, pid: u32) {
    let current = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<PidRecord>(&text).ok());
    if current.is_some_and(|record| record.pid == pid) {
        let _ = fs::remove_file(path);
    }
}

/// Stops a server left running by a TypeNext that crashed or was
/// force-quit. Never signals a process whose executable does not match.
pub(crate) fn reap_orphan(root: &Path, layout: &Layout) {
    let path = root.join(layout.pidfile);
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
        &normalize(&root.join(layout.runtime_dir)),
        layout.binary,
        live_path.as_deref(),
        owner_alive,
    ) {
        OrphanAction::Keep => return,
        OrphanAction::Discard => {}
        OrphanAction::Terminate => {
            log::warn!(
                "Stopping a {} left running since {}",
                layout.server,
                record.started_at
            );
            if !terminate_process(record.pid) {
                log::warn!("Could not stop the orphaned {}", layout.server);
                return;
            }
        }
    }
    let _ = fs::remove_file(&path);
}

#[cfg(target_os = "macos")]
pub(crate) fn process_path(pid: u32) -> Option<PathBuf> {
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
pub(crate) fn process_path(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    let path = fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    // A replaced executable reads as "<path> (deleted)".
    let bytes = path.as_os_str().as_bytes();
    let bytes = bytes.strip_suffix(b" (deleted)").unwrap_or(bytes);
    Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

#[cfg(target_os = "windows")]
pub(crate) fn process_path(pid: u32) -> Option<PathBuf> {
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
pub(crate) fn process_path(_pid: u32) -> Option<PathBuf> {
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

// State machine ------------------------------------------------------------

/// The parts of a managed runtime that differ between embeddings and speech.
pub(crate) trait RuntimeSpec: Send + Sync + 'static {
    /// What the frontend needs to reach a running server.
    type Running: Clone + Send + Sync + 'static;
    type Status: Clone + Send + 'static;
    fn snapshot(inner: &Inner<Self::Running>, supported: bool) -> Self::Status;
}

pub(crate) struct Inner<R> {
    pub installing: bool,
    pub starting: bool,
    pub progress: Option<Progress>,
    pub error: Option<String>,
    pub error_code: Option<&'static str>,
    pub server_binary: Option<PathBuf>,
    /// File names of model assets that are present and verified.
    pub models: Vec<&'static str>,
    pub disk_bytes: u64,
    verified: VerifyCache,
    server: Option<Server<R>>,
    install_token: Option<CancellationToken>,
    start_token: Option<CancellationToken>,
    launch: u64,
}

impl<R> Default for Inner<R> {
    fn default() -> Self {
        Self {
            installing: false,
            starting: false,
            progress: None,
            error: None,
            error_code: None,
            server_binary: None,
            models: Vec::new(),
            disk_bytes: 0,
            verified: VerifyCache::new(),
            server: None,
            install_token: None,
            start_token: None,
            launch: 0,
        }
    }
}

impl<R> Inner<R> {
    pub fn has_model(&self, file: &str) -> bool {
        self.models.contains(&file)
    }

    pub fn running(&self) -> Option<&R> {
        self.server
            .as_ref()
            .filter(|server| server.ready)
            .map(|server| &server.info)
    }

    pub fn state(&self, supported: bool) -> RuntimeState {
        if !supported {
            RuntimeState::Unsupported
        } else if self.installing {
            RuntimeState::Downloading
        } else if self.starting {
            RuntimeState::Starting
        } else if self.error.is_some() {
            RuntimeState::Error
        } else if self.running().is_some() {
            RuntimeState::Running
        } else {
            RuntimeState::Idle
        }
    }

    fn cancel_all(&self) {
        for token in [&self.install_token, &self.start_token]
            .into_iter()
            .flatten()
        {
            token.cancel();
        }
    }
}

/// Clears a ready server whose process has exited and records why. A server
/// that is still starting belongs to its `start` call, which reports failures.
fn reap_exited<R>(inner: &mut Inner<R>, layout: &Layout) -> Option<Server<R>> {
    let server = inner.server.as_mut().filter(|server| server.ready)?;
    let exit = match server.child.try_wait() {
        Ok(None) => return None,
        Ok(Some(status)) => status.to_string(),
        Err(error) => error.to_string(),
    };
    let server = inner.server.take()?;
    inner.error = Some(start_failure(
        &format!("The {} stopped unexpectedly ({exit})", layout.server),
        &server.log_lines(),
    ));
    inner.error_code = None;
    Some(server)
}

fn healthy_body(body: &[u8]) -> bool {
    // llama-server answers {"status":"ok"} once loaded; other servers may
    // answer plain text. A JSON status field must say "ok".
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(value) => value.get("status").is_none_or(|status| status == "ok"),
        Err(_) => true,
    }
}

type Emitter<S> = Arc<dyn Fn(&<S as RuntimeSpec>::Status) + Send + Sync>;

pub(crate) struct Core<S: RuntimeSpec> {
    root: PathBuf,
    layout: &'static Layout,
    runtime: Option<RuntimeAsset>,
    models: Vec<Asset>,
    emit: Emitter<S>,
    inner: Arc<Mutex<Inner<S::Running>>>,
    // Lock order: install, server, verify.
    install_lock: tokio::sync::Mutex<()>,
    server_lock: tokio::sync::Mutex<()>,
    verify_lock: tokio::sync::Mutex<()>,
}

impl<S: RuntimeSpec> Drop for Core<S> {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl<S: RuntimeSpec> Core<S> {
    /// Stops a server orphaned by an earlier crash before anything else.
    pub fn new(
        root: PathBuf,
        layout: &'static Layout,
        runtime: Option<RuntimeAsset>,
        models: Vec<Asset>,
        emit: impl Fn(&S::Status) + Send + Sync + 'static,
    ) -> Self {
        reap_orphan(&root, layout);
        Self {
            root,
            layout,
            runtime,
            models,
            emit: Arc::new(emit),
            inner: Arc::new(Mutex::new(Inner::default())),
            install_lock: tokio::sync::Mutex::new(()),
            server_lock: tokio::sync::Mutex::new(()),
            verify_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn lock(&self) -> MutexGuard<'_, Inner<S::Running>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn snapshot(&self) -> S::Status {
        S::snapshot(&self.lock(), self.runtime.is_some())
    }

    fn publish(&self) -> S::Status {
        let status = self.snapshot();
        (self.emit)(&status);
        status
    }

    fn unsupported(&self) -> String {
        format!(
            "The {} is not available for this platform",
            self.layout.runtime
        )
    }

    /// Kills the server synchronously. Called when the app exits.
    pub fn shutdown(&self) {
        let server = {
            let mut inner = self.lock();
            inner.cancel_all();
            inner.server.take()
        };
        drop(server);
    }

    async fn refresh(&self) -> Result<(), String> {
        let _verify = self.verify_lock.lock().await;
        let root = self.root.clone();
        let layout = self.layout;
        let runtime = self.runtime;
        let models = self.models.clone();
        let mut cache = self.lock().verified.clone();
        let (server_binary, models, disk_bytes, cache) = blocking(move || {
            let server =
                runtime.and_then(|runtime| verified_server(&root, layout, runtime, &mut cache));
            let directory = root.join(MODELS_DIR);
            let models: Vec<&'static str> = models
                .into_iter()
                .filter(|asset| {
                    verify_file(
                        &mut cache,
                        &directory.join(asset.file),
                        asset.bytes,
                        asset.sha256,
                    )
                })
                .map(|asset| asset.file)
                .collect();
            (server, models, directory_size(&root), cache)
        })
        .await?;
        let mut inner = self.lock();
        inner.verified = cache;
        inner.server_binary = server_binary;
        inner.models = models;
        inner.disk_bytes = disk_bytes;
        Ok(())
    }

    pub async fn status(&self) -> Result<S::Status, String> {
        let (exited, installing) = {
            let mut inner = self.lock();
            (reap_exited(&mut inner, self.layout), inner.installing)
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

    /// Downloads and verifies whatever `plan` lists as missing.
    pub async fn install(
        &self,
        auth: Option<HeaderValue>,
        plan: impl FnOnce(&Inner<S::Running>, RuntimeAsset) -> Vec<Job> + Send,
    ) -> Result<S::Status, String> {
        let runtime = self.runtime.ok_or_else(|| self.unsupported())?;
        let Ok(_install) = self.install_lock.try_lock() else {
            return Err("The files are already downloading".into());
        };
        let token = CancellationToken::new();
        {
            let mut inner = self.lock();
            inner.install_token = Some(token.clone());
            inner.installing = true;
            inner.progress = None;
            inner.error = None;
            inner.error_code = None;
        }
        self.publish();
        let mut result = self.run_install(runtime, auth, plan, &token).await;
        if let Err(error) = self.refresh().await {
            result = result.and(Err(error.into()));
        }
        {
            let mut inner = self.lock();
            inner.install_token = None;
            inner.installing = false;
            inner.progress = None;
            if let Err(failure) = &result {
                if failure.message != CANCELLED {
                    inner.error = Some(failure.message.clone());
                    inner.error_code = failure.code;
                }
            }
        }
        let status = self.publish();
        result.map(|()| status).map_err(|failure| failure.message)
    }

    async fn run_install(
        &self,
        runtime: RuntimeAsset,
        auth: Option<HeaderValue>,
        plan: impl FnOnce(&Inner<S::Running>, RuntimeAsset) -> Vec<Job>,
        token: &CancellationToken,
    ) -> Result<(), Failure> {
        self.refresh().await?;
        let mut jobs = plan(&self.lock(), runtime);
        for job in &mut jobs {
            job.auth = auth.clone().filter(|_| job.hugging_face);
        }
        if jobs.is_empty() {
            return Ok(());
        }
        let result = self.download_jobs(&jobs, token).await;
        if matches!(&result, Err(failure) if failure.message == CANCELLED) {
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

    async fn download_jobs(&self, jobs: &[Job], token: &CancellationToken) -> Result<(), Failure> {
        let client = download_client(true)?;
        let total: u64 = jobs.iter().map(|job| job.asset.bytes).sum();
        let mut completed = 0;
        for job in jobs {
            let mut last: Option<Instant> = None;
            download_verified(&client, job, token, |current| {
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
            })
            .await?;
            completed += job.asset.bytes;
            if let Some(kind) = job.archive {
                let root = self.root.clone();
                let layout = self.layout;
                let archive = job.destination.clone();
                let sha256 = job.asset.sha256;
                blocking(move || {
                    install_runtime_archive(&root, layout, &archive, kind, sha256)?;
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

    /// Starts a server unless one that `reusable` accepts is already running.
    /// `missing` explains what still has to be downloaded; `spec` builds the
    /// launch for a reserved port.
    pub async fn start(
        &self,
        reusable: impl Fn(&S::Running) -> bool + Send,
        missing: impl FnOnce(&Inner<S::Running>) -> Option<String> + Send,
        spec: impl Fn(u16) -> Result<LaunchSpec<S::Running>, String> + Send + Sync,
    ) -> Result<S::Status, String> {
        self.runtime.ok_or_else(|| self.unsupported())?;
        let _server = self.server_lock.lock().await;
        let exited = reap_exited(&mut self.lock(), self.layout);
        drop(exited);
        if self.lock().running().is_some_and(&reusable) {
            return Ok(self.snapshot());
        }
        self.refresh().await?;
        let (binary, previous) = {
            let mut inner = self.lock();
            if let Some(message) = missing(&inner) {
                return Err(message);
            }
            let Some(binary) = inner.server_binary.clone() else {
                return Err(format!("Download the {} first", self.layout.runtime));
            };
            (binary, inner.server.take())
        };
        drop(previous);
        let root = self.root.clone();
        let layout = self.layout;
        blocking(move || reap_orphan(&root, layout)).await?;

        let token = CancellationToken::new();
        {
            let mut inner = self.lock();
            inner.start_token = Some(token.clone());
            inner.starting = true;
            inner.error = None;
            inner.error_code = None;
        }
        self.publish();
        // A port reserved with bind(0) can be taken before the server binds it.
        let mut attempts = 0;
        let result = loop {
            attempts += 1;
            let result = self.launch(&binary, &spec, &token).await;
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
                    let message = match error {
                        StartError::Cancelled => {
                            format!("The {} start was cancelled", self.layout.server)
                        }
                        StartError::PortTaken => {
                            let message = format!(
                                "Could not find a free local port for the {}",
                                self.layout.server
                            );
                            inner.error = Some(message.clone());
                            message
                        }
                        StartError::Failed(message) => {
                            inner.error = Some(message.clone());
                            message
                        }
                    };
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
        spec: &(impl Fn(u16) -> Result<LaunchSpec<S::Running>, String> + Sync),
        token: &CancellationToken,
    ) -> Result<u64, StartError> {
        let port = free_port().map_err(StartError::Failed)?;
        let LaunchSpec {
            args,
            env,
            secret,
            running,
        } = spec(port).map_err(StartError::Failed)?;
        let mut child = server_command(binary, self.layout, args, env)
            .spawn()
            .map_err(|error| {
                StartError::Failed(format!("Could not run the {}: {error}", self.layout.server))
            })?;
        let logs = LogBuffer::default();
        capture(child.stdout.take(), &logs, secret.as_deref());
        capture(child.stderr.take(), &logs, secret.as_deref());
        let pidfile = write_pidfile(&self.root, self.layout.pidfile, child.id(), binary);
        let launch = {
            let mut inner = self.lock();
            inner.launch += 1;
            let launch = inner.launch;
            inner.server = Some(Server {
                child,
                info: running,
                ready: false,
                launch,
                logs,
                pidfile,
            });
            launch
        };
        let result = self
            .wait_until_ready(launch, port, secret.as_deref(), token)
            .await;
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
            Some(server) if server.launch == launch => server.log_lines(),
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
            &format!(
                "The {} exited before it was ready ({exit})",
                self.layout.server
            ),
            &logs,
        )))
    }

    async fn wait_until_ready(
        &self,
        launch: u64,
        port: u16,
        secret: Option<&str>,
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
                let mut request = client.get(&url);
                if let Some(secret) = secret {
                    request = request.bearer_auth(secret);
                }
                let response = request.send().await.ok()?;
                if response.status() != StatusCode::OK {
                    return None;
                }
                healthy_body(&response.bytes().await.ok()?).then_some(())
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
                    &format!(
                        "The {} did not become ready within 90 seconds",
                        self.layout.server
                    ),
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
        let layout = self.layout;
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
                    let exited = reap_exited(&mut inner, layout);
                    let status = exited.is_some().then(|| S::snapshot(&inner, supported));
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

    pub async fn stop(&self) -> S::Status {
        if let Some(token) = &self.lock().start_token {
            token.cancel();
        }
        let _server = self.server_lock.lock().await;
        let server = {
            let mut inner = self.lock();
            inner.error = None;
            inner.error_code = None;
            inner.server.take()
        };
        drop(server);
        self.publish()
    }

    pub async fn remove(&self) -> Result<S::Status, String> {
        self.lock().cancel_all();
        let _install = self.install_lock.lock().await;
        let _server = self.server_lock.lock().await;
        let _verify = self.verify_lock.lock().await;
        let server = self.lock().server.take();
        drop(server);
        let root = self.root.clone();
        let removed = blocking(move || match fs::remove_dir_all(&root) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not remove the downloaded files: {error}")),
        })
        .await?;
        let disk_bytes = directory_size(&self.root);
        {
            let mut inner = self.lock();
            inner.verified.clear();
            inner.server_binary = None;
            inner.models.clear();
            inner.disk_bytes = disk_bytes;
            inner.error = removed.as_ref().err().cloned();
            inner.error_code = None;
        }
        let status = self.publish();
        removed.map(|()| status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[cfg(target_os = "windows")]
    const SERVER_BINARY: &str = "llama-server.exe";
    #[cfg(not(target_os = "windows"))]
    const SERVER_BINARY: &str = "llama-server";
    const RUNTIME_DIR: &str = "runtime-b11696";
    const PIDFILE: &str = "llama-server.pid";

    static LAYOUT: Layout = Layout {
        release: "b11696",
        runtime_dir: RUNTIME_DIR,
        binary: SERVER_BINARY,
        pidfile: PIDFILE,
        server: "test server",
        runtime: "test runtime",
        clear_env: &[],
    };

    fn job(url: &str, destination: &Path, asset: Asset) -> Job {
        Job {
            asset,
            url: url.into(),
            destination: destination.into(),
            archive: None,
            hugging_face: false,
            auth: None,
        }
    }

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
        let error =
            install_runtime_archive(&root, &LAYOUT, &archive, ArchiveKind::Zip, "00").unwrap_err();
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
        install_runtime_archive(&root, &LAYOUT, &archive, ArchiveKind::Zip, &sha256).unwrap();
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
        install_runtime_archive(&root, &LAYOUT, &archive, ArchiveKind::TarGz, &sha256).unwrap();
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
            verified_server(&root, &LAYOUT, pinned, &mut cache),
            Some(runtime.join(SERVER_BINARY))
        );
        let other = RuntimeAsset {
            asset: Asset {
                sha256: "0000000000000000000000000000000000000000000000000000000000000000",
                ..pinned.asset
            },
            ..pinned
        };
        assert_eq!(
            verified_server(&root, &LAYOUT, other, &mut VerifyCache::new()),
            None
        );
        // Same-size tampering is caught once the file's stamp changes.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(runtime.join("LICENSE"), b"BSD").unwrap();
        assert_eq!(verified_server(&root, &LAYOUT, pinned, &mut cache), None);
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
            info: (),
            ready,
            launch: 1,
            logs: Arc::new(Mutex::new(VecDeque::from([
                "error: out of memory".to_string()
            ]))),
            pidfile: None,
        };
        let mut inner = Inner::<()> {
            server: Some(server(false)),
            ..Inner::default()
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(reap_exited(&mut inner, &LAYOUT).is_none());
        assert!(inner.server.is_some());

        inner.server = Some(server(true));
        std::thread::sleep(Duration::from_millis(200));
        assert!(reap_exited(&mut inner, &LAYOUT).is_some());
        assert!(inner.server.is_none());
        assert_eq!(inner.state(true), RuntimeState::Error);
        let error = inner.error.clone().unwrap();
        assert!(
            error.contains("test server stopped unexpectedly"),
            "{error}"
        );
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
            orphan_action(&record, &runtime, SERVER_BINARY, Some(&ours), false),
            OrphanAction::Terminate
        );
        // Exited, or still owned by a running TypeNext.
        assert_eq!(
            orphan_action(&record, &runtime, SERVER_BINARY, None, false),
            OrphanAction::Discard
        );
        assert_eq!(
            orphan_action(&record, &runtime, SERVER_BINARY, Some(&ours), true),
            OrphanAction::Keep
        );
        // The pid was reused by an unrelated program.
        let unrelated = std::env::temp_dir().join("bin").join("editor");
        assert_eq!(
            orphan_action(&record, &runtime, SERVER_BINARY, Some(&unrelated), false),
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
                orphan_action(&forged, &runtime, SERVER_BINARY, Some(&path), false),
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
        let path = write_pidfile(directory.path(), PIDFILE, 4242, &binary).unwrap();
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
        reap_orphan(directory.path(), &LAYOUT);
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
                    "\"$0\" --exact runtime_common::tests::orphan_fixture_child --ignored >/dev/null 2>&1 & echo $!",
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
        reap_orphan(&root, &LAYOUT);
        assert!(alive(stranger));
        assert!(!pidfile.exists());

        // A server whose TypeNext is still running is left alone.
        record(server, std::process::id());
        reap_orphan(&root, &LAYOUT);
        assert!(alive(server));
        assert!(pidfile.exists());

        // An orphaned managed server is stopped and its record removed.
        record(server, dead_owner);
        reap_orphan(&root, &LAYOUT);
        assert!(!alive(server));
        assert!(!pidfile.exists());

        // SAFETY: stranger is the fixture process verified above.
        unsafe { libc::kill(stranger as libc::pid_t, libc::SIGKILL) };
    }

    /// Answers each connection with the next scripted response and records
    /// the request heads it received.
    fn scripted_server(responses: Vec<String>) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).to_ascii_lowercase());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, requests)
    }

    #[test]
    fn hugging_face_tokens_are_optional_validated_and_sensitive() {
        assert_eq!(hugging_face_auth(None).unwrap(), None);
        assert_eq!(hugging_face_auth(Some("  ")).unwrap(), None);
        let value = hugging_face_auth(Some(" hf_abcDEF123 ")).unwrap().unwrap();
        assert_eq!(value.to_str().unwrap(), "Bearer hf_abcDEF123");
        assert!(value.is_sensitive());
        assert!(!format!("{value:?}").contains("hf_abc"));
        for invalid in ["hf_a b", "hf_\nb", "hf_\u{e9}"] {
            let error = hugging_face_auth(Some(invalid)).unwrap_err();
            assert!(!error.contains(invalid), "{error}");
        }
        assert!(hugging_face_auth(Some(&"a".repeat(4097))).is_err());
    }

    #[test]
    fn only_hugging_face_hosts_over_https_may_receive_the_token() {
        for url in [
            "https://huggingface.co/unsloth/model/resolve/abc/file.gguf",
            "https://HuggingFace.co/x",
            "https://cdn-lfs.huggingface.co/x",
        ] {
            assert!(is_hugging_face(url), "{url}");
        }
        for url in [
            "http://huggingface.co/x",
            "https://github.com/ggml-org/llama.cpp/releases/download/b1/x.zip",
            "https://evilhuggingface.co/x",
            "https://huggingface.co.example.com/x",
            "https://cas-bridge.xethub.hf.co/x",
            "not a url",
        ] {
            assert!(!is_hugging_face(url), "{url}");
        }
    }

    #[tokio::test]
    async fn the_token_reaches_hugging_face_but_never_a_redirect_target() {
        let body = b"model weights".to_vec();
        let asset = asset_for(&body);
        let (cdn_port, cdn_requests) = scripted_server(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\nmodel weights",
            body.len()
        )]);
        // "localhost" is a different host from 127.0.0.1, like a CDN.
        let (origin_port, origin_requests) = scripted_server(vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: http://localhost:{cdn_port}/signed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )]);
        let directory = tempfile::tempdir().unwrap();
        let mut job = job(
            &format!("http://127.0.0.1:{origin_port}/resolve/file.gguf"),
            &directory.path().join("file.gguf"),
            asset,
        );
        job.hugging_face = true;
        job.auth = hugging_face_auth(Some("hf_secret_token")).unwrap();
        download_verified(
            &download_client(false).unwrap(),
            &job,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&job.destination).unwrap(), body);
        assert!(
            origin_requests.lock().unwrap()[0].contains("authorization: bearer hf_secret_token")
        );
        let cdn = cdn_requests.lock().unwrap()[0].clone();
        assert!(
            !cdn.contains("authorization") && !cdn.contains("hf_secret_token"),
            "{cdn}"
        );

        // A job that is not for Hugging Face never sends it, even if set.
        let (port, requests) = scripted_server(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\nmodel weights",
            body.len()
        )]);
        let mut github = job.clone();
        github.url = format!("http://127.0.0.1:{port}/release.zip");
        github.destination = directory.path().join("release.zip");
        github.hugging_face = false;
        download_verified(
            &download_client(false).unwrap(),
            &github,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap();
        assert!(!requests.lock().unwrap()[0].contains("authorization"));
    }

    #[tokio::test]
    async fn hugging_face_refusals_map_to_error_codes_without_the_token() {
        let directory = tempfile::tempdir().unwrap();
        let refusal = |status: &str| {
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        };
        for (status, code, text) in [
            (
                "401 Unauthorized",
                Some(HUGGING_FACE_AUTH),
                HUGGING_FACE_AUTH_MESSAGE,
            ),
            (
                "403 Forbidden",
                Some(HUGGING_FACE_AUTH),
                HUGGING_FACE_AUTH_MESSAGE,
            ),
            (
                "429 Too Many Requests",
                Some(HUGGING_FACE_RATE_LIMIT),
                HUGGING_FACE_RATE_MESSAGE,
            ),
        ] {
            let (port, _) = scripted_server(vec![refusal(status)]);
            let mut job = job(
                &format!("http://127.0.0.1:{port}/model.gguf"),
                &directory.path().join("model.gguf"),
                asset_for(b"x"),
            );
            job.hugging_face = true;
            job.auth = hugging_face_auth(Some("hf_secret_token")).unwrap();
            let failure = download_verified(
                &download_client(false).unwrap(),
                &job,
                &CancellationToken::new(),
                |_| {},
            )
            .await
            .unwrap_err();
            assert_eq!((failure.code, failure.message.as_str()), (code, text));
            assert!(!failure.message.contains("hf_secret"));
        }
        // GitHub refusals, and refusals from a CDN Hugging Face redirected
        // to, keep the plain HTTP error.
        let (port, _) = scripted_server(vec![refusal("403 Forbidden")]);
        let plain = job(
            &format!("http://127.0.0.1:{port}/release.zip"),
            &directory.path().join("release.zip"),
            asset_for(b"x"),
        );
        let failure = download_verified(
            &download_client(false).unwrap(),
            &plain,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, None);
        assert!(failure.message.contains("HTTP 403"), "{}", failure.message);
        let (cdn_port, _) = scripted_server(vec![refusal("403 Forbidden")]);
        let (origin_port, _) = scripted_server(vec![format!(
            "HTTP/1.1 302 Found\r\nLocation: http://localhost:{cdn_port}/signed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )]);
        let mut redirected = job(
            &format!("http://127.0.0.1:{origin_port}/model.gguf"),
            &directory.path().join("redirected.gguf"),
            asset_for(b"x"),
        );
        redirected.hugging_face = true;
        let failure = download_verified(
            &download_client(false).unwrap(),
            &redirected,
            &CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, None);
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
        download_verified(&client, &job(&url, &destination, asset), &token, |bytes| {
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
            &job("http://127.0.0.1:9/unused", &destination, asset),
            &token,
            |_| {},
        )
        .await
        .unwrap();

        // A server that ignores the range restarts the file from zero.
        fs::remove_file(&destination).unwrap();
        fs::write(part_path(&destination), &body[..1_000]).unwrap();
        let (url, _) = file_server(body.clone(), 1, false);
        download_verified(&client, &job(&url, &destination, asset), &token, |_| {})
            .await
            .unwrap();
        assert_eq!(fs::read(&destination).unwrap(), body);

        // Corrupt content is discarded and never renamed into place.
        fs::remove_file(&destination).unwrap();
        let mut corrupt = body.clone();
        corrupt[123] ^= 0xff;
        let (url, _) = file_server(corrupt, 1, false);
        let error = download_verified(&client, &job(&url, &destination, asset), &token, |_| {})
            .await
            .unwrap_err();
        assert!(error.message.contains("SHA-256"), "{error:?}");
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
            &job(&url, &destination, asset),
            &token,
            |_| {},
        )
        .await
        .unwrap_err();
        assert_eq!(error.message, CANCELLED);
        assert!(!destination.exists());
    }
}
