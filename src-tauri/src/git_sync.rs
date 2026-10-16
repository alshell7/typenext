//! Git sync: notes are mirrored as Markdown files in a repository the writer
//! chooses, using the system `git`. Every git process runs asynchronously off
//! the interface thread with prompts disabled, a timeout and low priority, and
//! syncs of one folder run one at a time.

use crate::runtime_common::{blocking, hex};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};
use tauri::State;

const NOTES_DIR: &str = "notes";
const STATE_FILE: &str = "typenext-sync.json";
const ATTRIBUTES_FILE: &str = ".gitattributes";
const ATTRIBUTES_LINE: &str = "*.md text eol=lf";
const MAX_NOTES: usize = 10_000;
const MAX_IDS: usize = 100_000;
const MAX_NOTE_BYTES: usize = 8 * 1024 * 1024;
/// A rendered file adds front matter to the note's text.
const MAX_FILE_BYTES: u64 = MAX_NOTE_BYTES as u64 + 64 * 1024;
const MAX_TITLE_CHARS: usize = 1024;
const MAX_MESSAGE_CHARS: usize = 4096;
const MAX_SLUG: usize = 60;
const MAX_STATE_BYTES: u64 = 32 * 1024 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(15);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(60);
const DEFAULT_BRANCH: &str = "main";
const DEFAULT_MESSAGE: &str = "TypeNext: sync";
const FALLBACK_NAME: &str = "user.name=TypeNext";
const FALLBACK_EMAIL: &str = "user.email=typenext@localhost";

// Contract -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNote {
    id: String,
    title: String,
    content: String,
    updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    hash: String,
    message: String,
    time: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoStatus {
    git_installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_version: Option<String>,
    folder_exists: bool,
    is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_commit: Option<LastCommit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncStatus {
    Synced,
    Nothing,
    Busy,
    Offline,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncResult {
    status: SyncStatus,
    committed: bool,
    pulled: bool,
    pushed: bool,
    remote_changes: Vec<SyncNote>,
    remote_deleted_ids: Vec<String>,
    conflicts: Vec<SyncNote>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl GitSyncResult {
    fn new(status: SyncStatus) -> Self {
        Self {
            status,
            committed: false,
            pulled: false,
            pushed: false,
            remote_changes: Vec::new(),
            remote_deleted_ids: Vec::new(),
            conflicts: Vec::new(),
            error: None,
        }
    }

    fn failed(error: String) -> Self {
        Self {
            error: Some(error),
            ..Self::new(SyncStatus::Error)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    folder: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitRequest {
    folder: String,
    #[serde(default)]
    remote: Option<String>,
    #[serde(default)]
    branch: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    folder: String,
    #[serde(default)]
    notes: Vec<SyncNote>,
    #[serde(default)]
    deleted_ids: Vec<String>,
    #[serde(default)]
    known_ids: Vec<String>,
    #[serde(default)]
    message: String,
    #[serde(default)]
    pull: bool,
    #[serde(default)]
    push: bool,
}

// Validation ---------------------------------------------------------------

fn validate_folder(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if raw.len() > 4096 || raw.contains('\0') || !path.is_absolute() {
        return Err("Choose a folder for the notebook repository".into());
    }
    Ok(path)
}

fn validate_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_branch(branch: &str) -> Result<(), String> {
    let valid = !branch.is_empty()
        && branch.len() <= 100
        && !branch.starts_with(['-', '/', '.'])
        && !branch.ends_with(['/', '.'])
        && !branch.ends_with(".lock")
        && !branch.contains("..")
        && !branch.contains("//")
        && !branch.contains("@{")
        && branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'));
    if valid {
        Ok(())
    } else {
        Err("Use a branch name with letters, digits, dots, dashes or slashes".into())
    }
}

/// Remotes are HTTPS, SSH (`ssh://` or `user@host:path`) or local paths.
/// Transport helpers (`ext::`), option-like values and plain HTTP are refused.
fn validate_remote(raw: &str) -> Result<String, String> {
    let remote = raw.trim();
    let invalid =
        || "Use an https:// or ssh:// address, git@host:path, or a folder path".to_string();
    if remote.is_empty()
        || remote.len() > 2048
        || remote.starts_with('-')
        || remote.contains("::")
        || remote.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let no_spaces = !remote.contains(char::is_whitespace);
    for scheme in ["https://", "ssh://"] {
        if let Some(rest) = remote.strip_prefix(scheme) {
            return if no_spaces && rest.len() > 1 && !rest.starts_with(['/', '-']) {
                Ok(remote.into())
            } else {
                Err(invalid())
            };
        }
    }
    if let Some(rest) = remote.strip_prefix("file://") {
        // The path of a file URL is always absolute (/srv/notes.git, or
        // /C:/notes.git on Windows), so check the URL form, not the OS path.
        return if no_spaces
            && rest.len() > 1
            && rest.starts_with('/')
            && !rest[1..].starts_with('-')
        {
            Ok(remote.into())
        } else {
            Err(invalid())
        };
    }
    if remote.contains("://") {
        return Err(invalid());
    }
    // scp-like syntax: user@host:path
    if let Some((user_host, path)) = remote.split_once(':') {
        if let Some((user, host)) = user_host.split_once('@') {
            let plain = |text: &str, extra: &[u8]| {
                !text.is_empty()
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || extra.contains(&byte))
            };
            return if no_spaces
                && plain(user, b"._-")
                && plain(host, b".-")
                && !host.starts_with('-')
                && !path.is_empty()
                && !path.starts_with('-')
            {
                Ok(remote.into())
            } else {
                Err(invalid())
            };
        }
    }
    if Path::new(remote).is_absolute() {
        return Ok(remote.into());
    }
    Err(invalid())
}

/// Removes `user:password@` from every URL in `text`.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("://") {
        let (head, tail) = rest.split_at(index + 3);
        out.push_str(head);
        let end = tail
            .find(|ch: char| ch == '/' || ch.is_whitespace() || ch == '\'' || ch == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => out.push_str(&authority[at + 1..]),
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// A short message from git's stderr, without credentials.
fn git_message(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let line = lines
        .iter()
        .find(|line| line.starts_with("fatal:"))
        .or_else(|| lines.iter().find(|line| line.starts_with("error:")))
        .or_else(|| lines.last())
        .copied()
        .unwrap_or("Git did not finish");
    let line = line
        .trim_start_matches("fatal:")
        .trim_start_matches("error:")
        .trim();
    redact(line).chars().take(300).collect()
}

fn is_offline(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    [
        "could not resolve host",
        "could not resolve hostname",
        "unable to access",
        "connection refused",
        "connection timed out",
        "operation timed out",
        "network is unreachable",
        "no route to host",
        "failed to connect",
        "could not read from remote repository",
        "authentication failed",
        "permission denied",
        "terminal prompts disabled",
        "could not read username",
        "could not read password",
        "host key verification failed",
        "does not appear to be a git repository",
    ]
    .iter()
    .any(|pattern| stderr.contains(pattern))
}

// Note files ---------------------------------------------------------------

fn slug(title: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(ch.to_ascii_lowercase());
            if slug.len() >= MAX_SLUG {
                break;
            }
        } else {
            gap = true;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug.into()
    }
}

fn note_path(note: &SyncNote, id_chars: usize) -> String {
    let id: String = note.id.chars().take(id_chars).collect();
    format!("{NOTES_DIR}/{}--{id}.md", slug(&note.title))
}

/// A note file is a Markdown file directly inside `notes/`.
fn note_path_ok(path: &str) -> bool {
    let Some(name) = path.strip_prefix("notes/") else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 255
        && name.ends_with(".md")
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0', ':'])
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = (month + 9) % 12;
    let day_of_year = (153 * month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month + 2) / 5 + 1;
    let month = if month < 10 { month + 3 } else { month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Unix milliseconds as RFC 3339 UTC with millisecond precision.
fn format_rfc3339(ms: i64) -> String {
    let ms = ms.clamp(0, 253_402_300_799_999);
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let (hour, minute) = (rest / 3_600_000, rest / 60_000 % 60);
    let (second, millis) = (rest / 1000 % 60, rest % 1000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn parse_rfc3339(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut rest = &text[19..];
    let mut millis = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &fraction[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        rest = &fraction[digits..];
    }
    let offset_minutes = match rest {
        "Z" | "z" => 0,
        offset
            if offset.len() == 6
                && matches!(offset.as_bytes()[0], b'+' | b'-')
                && offset.as_bytes()[3] == b':' =>
        {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let hours = offset[1..3].parse::<i64>().ok()?;
            let minutes = offset[4..6].parse::<i64>().ok()?;
            sign * (hours * 60 + minutes)
        }
        _ => return None,
    };
    let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
        - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

fn render(note: &SyncNote) -> String {
    let title = serde_json::to_string(&note.title).unwrap_or_else(|_| "\"\"".into());
    let content = note.content.replace("\r\n", "\n");
    format!(
        "---\ntypenext-id: {}\ntitle: {title}\nupdated: {}\n---\n{content}",
        note.id,
        format_rfc3339(note.updated_at)
    )
}

/// Reads TypeNext front matter. `None` means the file was not written by
/// TypeNext (or was edited so its header is no longer valid).
fn parse_front_matter(text: &str) -> Option<SyncNote> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut offset = 0;
    let mut fields = HashMap::new();
    let mut content = None;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let line = line.trim_end_matches(['\n', '\r']);
        if line == "---" {
            content = Some(&rest[offset..]);
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            fields.insert(key.trim(), value.trim());
        }
    }
    let content = content?;
    let id = (*fields.get("typenext-id")?).to_string();
    if !validate_id(&id) {
        return None;
    }
    let title = match fields.get("title") {
        Some(title) if title.starts_with('"') => serde_json::from_str::<String>(title).ok()?,
        Some(title) => (*title).to_string(),
        None => String::new(),
    };
    Some(SyncNote {
        id,
        title,
        content: content.replace("\r\n", "\n"),
        updated_at: fields
            .get("updated")
            .and_then(|value| parse_rfc3339(value))
            .unwrap_or(0),
    })
}

/// A stable id for a hand-written file, shaped like a UUID.
fn derived_id(path: &str) -> String {
    let digest = hex(&Sha256::digest(path.as_bytes()));
    format!(
        "{}-{}-{}-{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32]
    )
}

/// A note from a file in `notes/`, written by TypeNext or by hand.
fn note_from_file(path: &str, text: &str, modified: i64) -> SyncNote {
    if let Some(note) = parse_front_matter(text) {
        return note;
    }
    let content = text.replace("\r\n", "\n");
    let heading = content
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let stem = Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().replace(['-', '_'], " "))
        .unwrap_or_default();
    SyncNote {
        id: derived_id(path),
        title: heading.map_or(stem, str::to_string),
        content,
        updated_at: modified,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

// Local sync state ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    path: String,
    hash: String,
    bytes: u64,
}

/// Kept in `.git/typenext-sync.json`, never committed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct SyncState {
    version: u8,
    notes: BTreeMap<String, Entry>,
}

impl SyncState {
    fn load(git_dir: &Path) -> Self {
        let path = git_dir.join(STATE_FILE);
        let state = fs::symlink_metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() <= MAX_STATE_BYTES)
            .and_then(|_| fs::read(&path).ok())
            .and_then(|bytes| serde_json::from_slice::<SyncState>(&bytes).ok());
        let mut state = state.unwrap_or_default();
        state
            .notes
            .retain(|id, entry| validate_id(id) && note_path_ok(&entry.path));
        state.version = 1;
        state
    }

    fn save(&self, git_dir: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        let mut file = tempfile::Builder::new()
            .prefix(".typenext-sync-")
            .tempfile_in(git_dir)
            .map_err(|error| format!("Could not save the sync state: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("Could not save the sync state: {error}"))?;
        file.persist(git_dir.join(STATE_FILE))
            .map_err(|error| format!("Could not save the sync state: {}", error.error))?;
        Ok(())
    }

    fn id_for_path(&self, path: &str) -> Option<String> {
        self.notes
            .iter()
            .find(|(_, entry)| entry.path == path)
            .map(|(id, _)| id.clone())
    }
}

// Files inside notes/ -------------------------------------------------------

fn ensure_notes_dir(folder: &Path) -> Result<(), String> {
    let path = folder.join(NOTES_DIR);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err("The repository's notes entry is not a plain folder".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&path)
            .map_err(|error| format!("Could not create the notes folder: {error}")),
        Err(error) => Err(format!("Could not open the notes folder: {error}")),
    }
}

/// Reads a regular note file; symlinks and oversized files are ignored.
fn read_note_file(folder: &Path, path: &str) -> Option<(String, i64)> {
    if !note_path_ok(path) {
        return None;
    }
    let full = folder.join(path);
    let metadata = fs::symlink_metadata(&full).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_millis() as i64);
    Some((fs::read_to_string(full).ok()?, modified))
}

fn file_matches(folder: &Path, path: &str, bytes: u64, hash: &str) -> bool {
    let full = folder.join(path);
    fs::symlink_metadata(&full).is_ok_and(|metadata| metadata.is_file() && metadata.len() == bytes)
        && fs::read(&full).is_ok_and(|content| sha256_hex(&content) == hash)
}

/// Replaces the file atomically. A symlink at the path is replaced itself,
/// never written through.
fn write_note_file(folder: &Path, path: &str, bytes: &[u8]) -> Result<(), String> {
    if !note_path_ok(path) {
        return Err("A note path escaped the notes folder".into());
    }
    let directory = folder.join(NOTES_DIR);
    let mut file = tempfile::Builder::new()
        .prefix(".typenext-")
        .tempfile_in(&directory)
        .map_err(|error| format!("Could not write a note file: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Could not write a note file: {error}"))?;
    file.persist(folder.join(path))
        .map_err(|error| format!("Could not write a note file: {}", error.error))?;
    Ok(())
}

fn remove_note_file(folder: &Path, path: &str) -> Result<(), String> {
    if !note_path_ok(path) {
        return Ok(());
    }
    let full = folder.join(path);
    match fs::symlink_metadata(&full) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => {
            fs::remove_file(&full).map_err(|error| format!("Could not remove a note file: {error}"))
        }
        Err(_) => Ok(()),
    }
}

fn list_note_files(folder: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(folder.join(NOTES_DIR)) else {
        return Vec::new();
    };
    let mut paths: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .map(|name| format!("{NOTES_DIR}/{name}"))
        .filter(|path| note_path_ok(path))
        .collect();
    paths.sort();
    paths
}

/// Writes changed notes and removes deleted ones. Returns whether anything
/// on disk changed.
fn write_notes(
    folder: &Path,
    state: &mut SyncState,
    notes: &[SyncNote],
    deleted_ids: &[String],
) -> Result<bool, String> {
    let mut claimed: HashMap<String, String> = state
        .notes
        .iter()
        .map(|(id, entry)| (entry.path.clone(), id.clone()))
        .collect();
    let mut changed = false;
    for note in notes {
        let text = render(note);
        let bytes = text.as_bytes();
        let hash = sha256_hex(bytes);
        let mut path = note_path(note, 8);
        if claimed.get(&path).is_some_and(|owner| owner != &note.id) {
            path = note_path(note, note.id.len());
        }
        let previous = state.notes.get(&note.id).cloned();
        let in_place = previous
            .as_ref()
            .is_some_and(|entry| entry.path == path && entry.hash == hash);
        // A missing state file must not rewrite identical files.
        if (in_place || previous.is_none())
            && file_matches(folder, &path, bytes.len() as u64, &hash)
        {
            claimed.insert(path.clone(), note.id.clone());
            state.notes.insert(
                note.id.clone(),
                Entry {
                    path,
                    hash,
                    bytes: bytes.len() as u64,
                },
            );
            continue;
        }
        write_note_file(folder, &path, bytes)?;
        changed = true;
        if let Some(previous) = previous.filter(|entry| entry.path != path) {
            if claimed.get(&previous.path) == Some(&note.id) {
                remove_note_file(folder, &previous.path)?;
                claimed.remove(&previous.path);
            }
        }
        claimed.insert(path.clone(), note.id.clone());
        state.notes.insert(
            note.id.clone(),
            Entry {
                path,
                hash,
                bytes: bytes.len() as u64,
            },
        );
    }
    for id in deleted_ids {
        let path = match state.notes.remove(id) {
            Some(entry) => Some(entry.path),
            None => {
                let suffix = format!("--{}.md", id.chars().take(8).collect::<String>());
                list_note_files(folder).into_iter().find(|path| {
                    path.ends_with(&suffix)
                        && read_note_file(folder, path)
                            .and_then(|(text, _)| parse_front_matter(&text))
                            .is_some_and(|note| &note.id == id)
                })
            }
        };
        if let Some(path) = path {
            if fs::symlink_metadata(folder.join(&path)).is_ok() {
                remove_note_file(folder, &path)?;
                changed = true;
            }
        }
    }
    Ok(changed)
}

fn ensure_attributes(folder: &Path) -> Result<(), String> {
    let path = folder.join(ATTRIBUTES_FILE);
    let existing = match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => fs::read_to_string(&path).unwrap_or_default(),
        Ok(_) => return Err("The repository's .gitattributes is not a plain file".into()),
        Err(_) => String::new(),
    };
    if existing.lines().any(|line| line.trim() == ATTRIBUTES_LINE) {
        return Ok(());
    }
    let mut text = existing;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(ATTRIBUTES_LINE);
    text.push('\n');
    fs::write(&path, text).map_err(|error| format!("Could not write .gitattributes: {error}"))
}

// Running git --------------------------------------------------------------

#[derive(Debug)]
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug, PartialEq, Eq)]
enum GitError {
    Missing,
    Timeout,
    Failed(String),
}

impl GitError {
    fn message(&self) -> String {
        match self {
            Self::Missing => "Git is not installed on this computer".into(),
            Self::Timeout => "Git took too long to answer".into(),
            Self::Failed(message) => message.clone(),
        }
    }
}

struct Git {
    program: PathBuf,
    folder: PathBuf,
    config: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
}

impl Git {
    async fn run(&self, args: &[&str], timeout: Duration) -> Result<Output, GitError> {
        let mut command = tokio::process::Command::new(&self.program);
        command
            .args(&self.config)
            .args(args)
            .current_dir(&self.folder)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            // Never wait on a prompt that nobody can answer.
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "never")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .env("LANGUAGE", "C")
            .envs(self.env.iter().map(|(key, value)| (key, value)));
        #[cfg(unix)]
        // SAFETY: setpriority is async-signal-safe and only lowers the
        // priority of the forked child before it executes git.
        unsafe {
            command.pre_exec(|| {
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                Ok(())
            });
        }
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
            command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        }
        let output = match tokio::time::timeout(timeout, command.output()).await {
            Err(_) => return Err(GitError::Timeout),
            Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Err(GitError::Missing)
            }
            Ok(Err(error)) => return Err(GitError::Failed(format!("Could not run Git: {error}"))),
            Ok(Ok(output)) => output,
        };
        Ok(Output {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    /// Runs a local command that must succeed and returns its stdout.
    async fn ok(&self, args: &[&str]) -> Result<String, GitError> {
        let output = self.run(args, LOCAL_TIMEOUT).await?;
        if output.success {
            Ok(output.stdout)
        } else {
            Err(GitError::Failed(git_message(&output.stderr)))
        }
    }

    /// Trimmed stdout of a local command, or `None` when it fails.
    async fn text(&self, args: &[&str]) -> Result<Option<String>, GitError> {
        let output = self.run(args, LOCAL_TIMEOUT).await?;
        let text = output.stdout.trim().to_string();
        Ok((output.success && !text.is_empty()).then_some(text))
    }

    async fn succeeds(&self, args: &[&str]) -> Result<bool, GitError> {
        Ok(self.run(args, LOCAL_TIMEOUT).await?.success)
    }

    async fn version(&self) -> Result<Option<String>, GitError> {
        let output = self.run(&["--version"], LOCAL_TIMEOUT).await?;
        if !output.success {
            return Err(GitError::Missing);
        }
        Ok(output
            .stdout
            .trim()
            .strip_prefix("git version ")
            .map(str::to_string))
    }

    async fn is_repo_root(&self) -> Result<bool, GitError> {
        let Some(top) = self.text(&["rev-parse", "--show-toplevel"]).await? else {
            return Ok(false);
        };
        let same = |a: &Path, b: &Path| {
            fs::canonicalize(a)
                .ok()
                .zip(fs::canonicalize(b).ok())
                .is_some_and(|(a, b)| a == b)
        };
        Ok(same(Path::new(&top), &self.folder))
    }

    async fn head(&self) -> Result<Option<String>, GitError> {
        self.text(&["rev-parse", "-q", "--verify", "HEAD^{commit}"])
            .await
    }

    async fn branch(&self) -> Result<Option<String>, GitError> {
        self.text(&["symbolic-ref", "--short", "-q", "HEAD"]).await
    }

    async fn upstream(&self) -> Result<Option<String>, GitError> {
        self.text(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
            .await
    }

    async fn origin(&self) -> Result<Option<String>, GitError> {
        self.text(&["remote", "get-url", "origin"]).await
    }

    async fn show(&self, revision: &str, path: &str) -> Result<Option<String>, GitError> {
        let output = self
            .run(&["show", &format!("{revision}:{path}")], LOCAL_TIMEOUT)
            .await?;
        Ok(
            (output.success && output.stdout.len() as u64 <= MAX_FILE_BYTES)
                .then_some(output.stdout),
        )
    }

    /// Note paths changed between `base` (or all files when `None`) and `revision`.
    async fn changed_notes(
        &self,
        base: Option<&str>,
        revision: &str,
    ) -> Result<HashSet<String>, GitError> {
        let output = match base {
            Some(base) => {
                self.ok(&[
                    "diff",
                    "--name-only",
                    "--no-renames",
                    "-z",
                    base,
                    revision,
                    "--",
                    "notes/",
                ])
                .await?
            }
            None => {
                self.ok(&[
                    "ls-tree",
                    "-r",
                    "--name-only",
                    "-z",
                    revision,
                    "--",
                    "notes/",
                ])
                .await?
            }
        };
        Ok(output
            .split('\0')
            .filter(|path| note_path_ok(path))
            .map(str::to_string)
            .collect())
    }

    /// Fallback identity flags when user.name or user.email is not configured.
    async fn identity(&self) -> Result<Vec<OsString>, GitError> {
        let mut config = Vec::new();
        if self.text(&["config", "user.name"]).await?.is_none() {
            config.extend(["-c".into(), FALLBACK_NAME.into()]);
        }
        if self.text(&["config", "user.email"]).await?.is_none() {
            config.extend(["-c".into(), FALLBACK_EMAIL.into()]);
        }
        Ok(config)
    }
}

/// Finds git like a terminal would, including install locations that GUI
/// apps do not have on their PATH.
fn resolve_git(configured: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = configured {
        return Some(path.to_path_buf());
    }
    #[cfg(target_os = "windows")]
    let (name, extra) = (
        "git.exe",
        vec![
            PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"),
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let (name, extra) = (
        "git",
        vec![
            PathBuf::from("/opt/homebrew/bin/git"),
            PathBuf::from("/usr/local/bin/git"),
            PathBuf::from("/usr/bin/git"),
        ],
    );
    let found = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(name))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
        .into_iter()
        .chain(extra)
        .find(|path| path.is_file())?;
    // /usr/bin/git on macOS is a shim that opens an installer dialog when the
    // command line tools are missing.
    #[cfg(target_os = "macos")]
    if found == Path::new("/usr/bin/git")
        && !std::process::Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    {
        return None;
    }
    Some(found)
}

// State --------------------------------------------------------------------

#[derive(Default)]
pub struct GitSyncState {
    /// Injected in tests; production finds the system git.
    git: Option<PathBuf>,
    env: Vec<(OsString, OsString)>,
    active: Mutex<HashSet<PathBuf>>,
}

struct BusyGuard<'a> {
    active: &'a Mutex<HashSet<PathBuf>>,
    key: PathBuf,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.key);
    }
}

fn not_a_repo() -> String {
    "This folder is not a Git repository yet. Set up sync first.".into()
}

impl GitSyncState {
    fn try_busy(&self, folder: &Path) -> Option<BusyGuard<'_>> {
        let key = fs::canonicalize(folder).unwrap_or_else(|_| folder.to_path_buf());
        let inserted = self
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.clone());
        // The guard must only exist for an insert it owns: its drop removes
        // the key and takes the lock.
        if inserted {
            Some(BusyGuard {
                active: &self.active,
                key,
            })
        } else {
            None
        }
    }

    async fn git(&self, folder: &Path) -> Result<Git, GitError> {
        let configured = self.git.clone();
        let program = blocking(move || resolve_git(configured.as_deref()))
            .await
            .map_err(GitError::Failed)?
            .ok_or(GitError::Missing)?;
        Ok(Git {
            program,
            folder: folder.to_path_buf(),
            config: Vec::new(),
            env: self.env.clone(),
        })
    }

    pub async fn check(&self, request: CheckRequest) -> Result<GitRepoStatus, String> {
        let folder = validate_folder(&request.folder)?;
        Ok(self.check_folder(&folder).await)
    }

    async fn check_folder(&self, folder: &Path) -> GitRepoStatus {
        let mut status = GitRepoStatus {
            folder_exists: folder.is_dir(),
            ..GitRepoStatus::default()
        };
        // Git runs in the folder, so a missing folder only reports the version.
        let base = if status.folder_exists {
            folder.to_path_buf()
        } else {
            std::env::temp_dir()
        };
        let Ok(git) = self.git(&base).await else {
            return status;
        };
        let Ok(version) = git.version().await else {
            return status;
        };
        status.git_installed = true;
        status.git_version = version;
        if !status.folder_exists || !git.is_repo_root().await.unwrap_or(false) {
            return status;
        }
        status.is_repo = true;
        status.branch = git.branch().await.ok().flatten();
        status.remote = git.origin().await.ok().flatten().map(|url| redact(&url));
        status.upstream = git.upstream().await.ok().flatten();
        if status.upstream.is_some() {
            if let Ok(Some(counts)) = git
                .text(&["rev-list", "--left-right", "--count", "HEAD...@{u}"])
                .await
            {
                let mut counts = counts
                    .split_whitespace()
                    .map(|count| count.parse().unwrap_or(0));
                status.ahead = counts.next().unwrap_or(0);
                status.behind = counts.next().unwrap_or(0);
            }
        }
        status.dirty = git
            .text(&["status", "--porcelain", "--untracked-files=normal"])
            .await
            .ok()
            .flatten()
            .is_some();
        status.last_commit = git
            .text(&["log", "-1", "--format=%h%x00%s%x00%ct"])
            .await
            .ok()
            .flatten()
            .and_then(|line| {
                let mut parts = line.splitn(3, '\0');
                Some(LastCommit {
                    hash: parts.next()?.to_string(),
                    message: parts.next()?.to_string(),
                    time: parts.next()?.trim().parse::<i64>().ok()? * 1000,
                })
            });
        status
    }

    pub async fn init(&self, request: InitRequest) -> Result<GitRepoStatus, String> {
        let folder = validate_folder(&request.folder)?;
        let remote = request
            .remote
            .as_deref()
            .filter(|remote| !remote.trim().is_empty())
            .map(validate_remote)
            .transpose()?;
        let branch = request
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .unwrap_or(DEFAULT_BRANCH)
            .to_string();
        validate_branch(&branch)?;
        let Some(_busy) = self.try_busy(&folder) else {
            return Err("A sync is running for this folder. Try again in a moment.".into());
        };
        let create = folder.clone();
        blocking(move || fs::create_dir_all(&create))
            .await?
            .map_err(|error| format!("Could not create the folder: {error}"))?;
        let git = self.git(&folder).await.map_err(|error| error.message())?;
        git.version().await.map_err(|error| error.message())?;
        if !git.is_repo_root().await.map_err(|error| error.message())? {
            let initialized = git
                .run(&["init", "-q", "-b", &branch], LOCAL_TIMEOUT)
                .await
                .map_err(|error| error.message())?;
            if !initialized.success {
                // git before 2.28 has no -b.
                git.ok(&["init", "-q"])
                    .await
                    .map_err(|error| error.message())?;
                git.ok(&["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])
                    .await
                    .map_err(|error| error.message())?;
            }
        }
        let attributes = folder.clone();
        blocking(move || ensure_attributes(&attributes)).await??;
        if let Some(remote) = remote {
            match git.origin().await.map_err(|error| error.message())? {
                None => {
                    git.ok(&["remote", "add", "origin", &remote])
                        .await
                        .map_err(|error| error.message())?;
                }
                Some(existing) if existing.trim() == remote => {}
                Some(existing) => {
                    return Err(format!(
                        "This folder already syncs with {}. Remove that remote first to use another one.",
                        redact(&existing)
                    ))
                }
            }
        }
        Ok(self.check_folder(&folder).await)
    }

    pub async fn run(&self, request: RunRequest) -> GitSyncResult {
        let folder = match validate_folder(&request.folder) {
            Ok(folder) => folder,
            Err(error) => return GitSyncResult::failed(error),
        };
        let Some(_busy) = self.try_busy(&folder) else {
            return GitSyncResult::new(SyncStatus::Busy);
        };
        let mut result = GitSyncResult::new(SyncStatus::Nothing);
        if let Err(error) = self.sync(&folder, request, &mut result).await {
            result.status = SyncStatus::Error;
            result.error = Some(error);
        }
        result
    }

    async fn sync(
        &self,
        folder: &Path,
        request: RunRequest,
        result: &mut GitSyncResult,
    ) -> Result<(), String> {
        validate_run(&request)?;
        let error = |error: GitError| error.message();
        let mut git = self.git(folder).await.map_err(error)?;
        if !folder.is_dir() || !git.is_repo_root().await.map_err(error)? {
            return Err(not_a_repo());
        }
        git.config = git.identity().await.map_err(error)?;
        let git_dir = PathBuf::from(
            git.text(&["rev-parse", "--absolute-git-dir"])
                .await
                .map_err(error)?
                .ok_or_else(not_a_repo)?,
        );
        let RunRequest {
            notes,
            deleted_ids,
            known_ids,
            message,
            pull,
            push,
            ..
        } = request;
        let message = Some(message.trim())
            .filter(|message| !message.is_empty())
            .unwrap_or(DEFAULT_MESSAGE)
            .to_string();

        // 1. Write changed notes and commit them.
        let mut state = {
            let folder = folder.to_path_buf();
            let git_dir = git_dir.clone();
            let notes = notes.clone();
            let deleted_ids = deleted_ids.clone();
            blocking(move || -> Result<SyncState, String> {
                ensure_notes_dir(&folder)?;
                let mut state = SyncState::load(&git_dir);
                write_notes(&folder, &mut state, &notes, &deleted_ids)?;
                state.save(&git_dir)?;
                Ok(state)
            })
            .await??
        };
        // An empty notes folder is invisible to git, so its pathspec would
        // not match anything unless files exist or were tracked.
        let mut paths = Vec::new();
        let has_files = fs::read_dir(folder.join(NOTES_DIR))
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
        if has_files
            || git
                .text(&["ls-files", "--", NOTES_DIR])
                .await
                .map_err(error)?
                .is_some()
        {
            paths.push(NOTES_DIR);
        }
        if folder.join(ATTRIBUTES_FILE).is_file() {
            paths.push(ATTRIBUTES_FILE);
        }
        let mut add = vec!["add", "-A", "--"];
        add.extend(&paths);
        if !paths.is_empty() {
            git.ok(&add).await.map_err(error)?;
        }
        let mut staged = vec!["diff", "--cached", "--quiet", "--"];
        staged.extend(&paths);
        if !paths.is_empty() && !git.succeeds(&staged).await.map_err(error)? {
            let mut commit = vec!["commit", "-q", "-m", message.as_str(), "--"];
            commit.extend(&paths);
            git.ok(&commit).await.map_err(error)?;
            result.committed = true;
        }

        // 2. Fetch, then rebase local commits onto the remote.
        let branch = git.branch().await.map_err(error)?;
        let has_origin = git.origin().await.map_err(error)?.is_some();
        let mut upstream = None;
        if has_origin && (pull || push) {
            match git
                .run(&["fetch", "--prune", "-q", "origin"], NETWORK_TIMEOUT)
                .await
            {
                Ok(output) if output.success => {}
                Ok(output) if is_offline(&output.stderr) => {
                    result.status = SyncStatus::Offline;
                    result.error = Some(git_message(&output.stderr));
                    return Ok(());
                }
                Ok(output) => return Err(git_message(&output.stderr)),
                Err(GitError::Timeout) => {
                    result.status = SyncStatus::Offline;
                    result.error = Some("The remote did not answer in time".into());
                    return Ok(());
                }
                Err(other) => return Err(other.message()),
            }
            upstream = match git.upstream().await.map_err(error)? {
                Some(upstream) => Some(upstream),
                None => match &branch {
                    Some(branch)
                        if git
                            .succeeds(&[
                                "rev-parse",
                                "-q",
                                "--verify",
                                &format!("refs/remotes/origin/{branch}"),
                            ])
                            .await
                            .map_err(error)? =>
                    {
                        Some(format!("origin/{branch}"))
                    }
                    _ => None,
                },
            };
        }
        let mut conflict_paths = HashSet::new();
        if let (true, Some(upstream)) = (pull, upstream.as_deref()) {
            let before = git.head().await.map_err(error)?;
            match &before {
                None => {
                    // Nothing committed here yet: adopt the remote branch.
                    let branch = branch.clone().unwrap_or_else(|| DEFAULT_BRANCH.into());
                    git.ok(&["checkout", "-q", "-B", &branch, upstream])
                        .await
                        .map_err(error)?;
                }
                Some(before) => {
                    let up_to_date = git
                        .succeeds(&["merge-base", "--is-ancestor", upstream, "HEAD"])
                        .await
                        .map_err(error)?;
                    if !up_to_date {
                        conflict_paths = self.integrate(&git, before, upstream, result).await?;
                    }
                }
            }
            let after = git.head().await.map_err(error)?;
            if after != before {
                result.pulled = true;
                let changed = self
                    .remote_changes(&git, before.as_deref(), &conflict_paths)
                    .await
                    .map_err(error)?;
                let folder = folder.to_path_buf();
                let (next, changes, deleted) = blocking(move || {
                    let mut state = state;
                    let (changes, deleted) = apply_remote(&folder, &mut state, changed);
                    (state, changes, deleted)
                })
                .await?;
                state = next;
                result.remote_changes = changes;
                result.remote_deleted_ids = deleted;
            }
        }

        // 3. Notes this app does not know yet: new files from other
        // computers, hand-written files and anything the app lost.
        {
            let folder = folder.to_path_buf();
            let git_dir = git_dir.clone();
            let mut known: HashSet<String> = known_ids.into_iter().collect();
            known.extend(notes.iter().map(|note| note.id.clone()));
            known.extend(deleted_ids.iter().cloned());
            known.extend(result.remote_changes.iter().map(|note| note.id.clone()));
            known.extend(result.remote_deleted_ids.iter().cloned());
            let unknown = blocking(move || -> Result<Vec<SyncNote>, String> {
                let mut state = state;
                let unknown = adopt_unknown(&folder, &mut state, &known);
                state.save(&git_dir)?;
                Ok(unknown)
            })
            .await??;
            result.remote_changes.extend(unknown);
        }

        // 4. Push.
        if let (true, true, Some(branch)) = (push, has_origin, branch.as_deref()) {
            if git.head().await.map_err(error)?.is_some() {
                let tracking = git.upstream().await.map_err(error)?;
                let ahead = match upstream.as_deref() {
                    Some(upstream) => git
                        .text(&["rev-list", "--count", &format!("{upstream}..HEAD")])
                        .await
                        .map_err(error)?
                        .and_then(|count| count.parse::<u32>().ok())
                        .unwrap_or(0),
                    None => 1,
                };
                if ahead > 0 || tracking.is_none() {
                    let mut args = vec!["push", "-q"];
                    if tracking.is_none() {
                        args.push("-u");
                    }
                    args.extend(["origin", branch]);
                    match git.run(&args, NETWORK_TIMEOUT).await {
                        Ok(output) if output.success => result.pushed = ahead > 0,
                        Ok(output)
                            if output.stderr.contains("[rejected]")
                                || output.stderr.contains("non-fast-forward")
                                || output.stderr.contains("fetch first") =>
                        {
                            return Err("The remote changed during this sync. Sync again to bring those changes in.".into());
                        }
                        Ok(output) if is_offline(&output.stderr) => {
                            result.status = SyncStatus::Offline;
                            result.error = Some(git_message(&output.stderr));
                            return Ok(());
                        }
                        Ok(output) => return Err(git_message(&output.stderr)),
                        Err(GitError::Timeout) => {
                            result.status = SyncStatus::Offline;
                            result.error = Some("The remote did not answer in time".into());
                            return Ok(());
                        }
                        Err(other) => return Err(other.message()),
                    }
                }
            }
        }

        result.status = if result.committed
            || result.pulled
            || result.pushed
            || !result.remote_changes.is_empty()
            || !result.remote_deleted_ids.is_empty()
            || !result.conflicts.is_empty()
        {
            SyncStatus::Synced
        } else {
            SyncStatus::Nothing
        };
        Ok(())
    }

    /// Rebases onto `upstream`; on conflict falls back to a merge where the
    /// local text wins, and reports the remote version of every note both
    /// sides changed. Returns those paths.
    async fn integrate(
        &self,
        git: &Git,
        before: &str,
        upstream: &str,
        result: &mut GitSyncResult,
    ) -> Result<HashSet<String>, String> {
        let error = |error: GitError| error.message();
        let rebase = git
            .run(
                &["rebase", "--autostash", "-q", upstream],
                LOCAL_TIMEOUT * 4,
            )
            .await
            .map_err(error)?;
        if rebase.success {
            return Ok(HashSet::new());
        }
        let _ = git.run(&["rebase", "--abort"], LOCAL_TIMEOUT).await;
        let base = git
            .text(&["merge-base", before, upstream])
            .await
            .map_err(error)?;
        let ours = git
            .changed_notes(base.as_deref(), before)
            .await
            .map_err(error)?;
        let theirs = git
            .changed_notes(base.as_deref(), upstream)
            .await
            .map_err(error)?;
        let mut conflicts = HashSet::new();
        for path in ours.intersection(&theirs) {
            let local = git.show(before, path).await.map_err(error)?;
            let remote = git.show(upstream, path).await.map_err(error)?;
            if local == remote {
                continue;
            }
            if let Some(remote) = remote {
                result.conflicts.push(note_from_file(path, &remote, 0));
            }
            conflicts.insert(path.clone());
        }
        let merge = git
            .run(
                &[
                    "merge",
                    "--no-edit",
                    "-q",
                    "--allow-unrelated-histories",
                    "-X",
                    "ours",
                    upstream,
                ],
                LOCAL_TIMEOUT * 4,
            )
            .await
            .map_err(error)?;
        let unmerged: HashSet<String> = git
            .ok(&["diff", "--name-only", "--diff-filter=U", "-z"])
            .await
            .map_err(error)?
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect();
        if !merge.success && unmerged.is_empty() {
            let _ = git.run(&["merge", "--abort"], LOCAL_TIMEOUT).await;
            return Err(git_message(&merge.stderr));
        }
        // Local text wins exactly, not only in the conflicting hunks.
        for path in conflicts.iter().chain(unmerged.difference(&conflicts)) {
            if git
                .succeeds(&["cat-file", "-e", &format!("{before}:{path}")])
                .await
                .map_err(error)?
            {
                git.ok(&["checkout", before, "--", path])
                    .await
                    .map_err(error)?;
            } else {
                git.ok(&["rm", "-q", "-f", "--ignore-unmatch", "--", path])
                    .await
                    .map_err(error)?;
            }
        }
        if !merge.success {
            git.ok(&["commit", "-q", "--no-edit"])
                .await
                .map_err(error)?;
        } else if !git
            .succeeds(&["diff", "--cached", "--quiet"])
            .await
            .map_err(error)?
        {
            git.ok(&["commit", "-q", "--amend", "--no-edit"])
                .await
                .map_err(error)?;
        }
        Ok(conflicts)
    }

    async fn remote_changes(
        &self,
        git: &Git,
        before: Option<&str>,
        conflicts: &HashSet<String>,
    ) -> Result<Vec<(char, String)>, GitError> {
        let output = match before {
            Some(before) => {
                git.ok(&[
                    "diff",
                    "--name-status",
                    "--no-renames",
                    "-z",
                    before,
                    "HEAD",
                    "--",
                    "notes/",
                ])
                .await?
            }
            None => {
                git.ok(&["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", "notes/"])
                    .await?
            }
        };
        let mut fields = output.split('\0').filter(|field| !field.is_empty());
        let mut changes = Vec::new();
        while let Some(field) = fields.next() {
            let (kind, path) = match before {
                Some(_) => (
                    field.chars().next().unwrap_or('M'),
                    fields.next().unwrap_or_default(),
                ),
                None => ('A', field),
            };
            if note_path_ok(path) && !conflicts.contains(path) {
                changes.push((kind, path.to_string()));
            }
        }
        Ok(changes)
    }
}

/// Turns pulled file changes into notes and updates the local state.
fn apply_remote(
    folder: &Path,
    state: &mut SyncState,
    changed: Vec<(char, String)>,
) -> (Vec<SyncNote>, Vec<String>) {
    let mut notes: Vec<SyncNote> = Vec::new();
    let mut deleted_paths = Vec::new();
    for (kind, path) in changed {
        if kind == 'D' {
            deleted_paths.push(path);
            continue;
        }
        let Some((text, modified)) = read_note_file(folder, &path) else {
            continue;
        };
        let note = note_from_file(&path, &text, modified);
        state.notes.insert(
            note.id.clone(),
            Entry {
                path,
                hash: sha256_hex(text.as_bytes()),
                bytes: text.len() as u64,
            },
        );
        notes.retain(|existing| existing.id != note.id);
        notes.push(note);
    }
    let mut deleted = Vec::new();
    for path in deleted_paths {
        let Some(id) = state.id_for_path(&path) else {
            continue;
        };
        // A rename shows up as a deletion plus an addition of the same id.
        if notes.iter().any(|note| note.id == id) {
            continue;
        }
        state.notes.remove(&id);
        deleted.push(id);
    }
    (notes, deleted)
}

/// Records files the state does not track yet and returns the notes the app
/// does not know.
fn adopt_unknown(folder: &Path, state: &mut SyncState, known: &HashSet<String>) -> Vec<SyncNote> {
    let tracked: HashSet<String> = state
        .notes
        .values()
        .map(|entry| entry.path.clone())
        .collect();
    let mut unknown = Vec::new();
    for path in list_note_files(folder) {
        if tracked.contains(&path) {
            continue;
        }
        let Some((text, modified)) = read_note_file(folder, &path) else {
            continue;
        };
        let note = note_from_file(&path, &text, modified);
        if state.notes.contains_key(&note.id) {
            // Two files claim one id; the tracked one stays authoritative.
            continue;
        }
        state.notes.insert(
            note.id.clone(),
            Entry {
                path,
                hash: sha256_hex(text.as_bytes()),
                bytes: text.len() as u64,
            },
        );
        if !known.contains(&note.id) {
            unknown.push(note);
        }
    }
    let seen: HashSet<String> = unknown.iter().map(|note| note.id.clone()).collect();
    let lost: Vec<(String, String)> = state
        .notes
        .iter()
        .filter(|(id, _)| !known.contains(*id) && !seen.contains(*id))
        .map(|(id, entry)| (id.clone(), entry.path.clone()))
        .collect();
    for (id, path) in lost {
        match read_note_file(folder, &path) {
            Some((text, modified)) => unknown.push(note_from_file(&path, &text, modified)),
            None => {
                state.notes.remove(&id);
            }
        }
    }
    unknown
}

fn validate_run(request: &RunRequest) -> Result<(), String> {
    if request.notes.len() > MAX_NOTES {
        return Err(format!("Sync supports up to {MAX_NOTES} notes at a time"));
    }
    if request.deleted_ids.len() > MAX_IDS || request.known_ids.len() > MAX_IDS {
        return Err("Too many notes to sync at once".into());
    }
    let mut ids = HashSet::new();
    for note in &request.notes {
        if !validate_id(&note.id) || !ids.insert(note.id.as_str()) {
            return Err("A note has a missing or duplicate identifier".into());
        }
        if note.content.len() > MAX_NOTE_BYTES {
            return Err(format!(
                "“{}” is larger than 8 MB and cannot be synced",
                note.title.chars().take(80).collect::<String>()
            ));
        }
        if note.title.chars().count() > MAX_TITLE_CHARS {
            return Err("A note title is too long to sync".into());
        }
    }
    if request.deleted_ids.iter().any(|id| !validate_id(id))
        || request.known_ids.iter().any(|id| !validate_id(id))
    {
        return Err("A note identifier is invalid".into());
    }
    if request.message.chars().count() > MAX_MESSAGE_CHARS || request.message.contains('\0') {
        return Err("The commit message is too long".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn git_sync_check(
    state: State<'_, GitSyncState>,
    request: CheckRequest,
) -> Result<GitRepoStatus, String> {
    state.check(request).await
}

#[tauri::command]
pub async fn git_sync_init(
    state: State<'_, GitSyncState>,
    request: InitRequest,
) -> Result<GitRepoStatus, String> {
    state.init(request).await
}

#[tauri::command]
pub async fn git_sync_run(
    state: State<'_, GitSyncState>,
    request: RunRequest,
) -> Result<GitSyncResult, String> {
    Ok(state.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    const N1: &str = "11111111-aaaa-4aaa-8aaa-000000000001";
    const N2: &str = "22222222-bbbb-4bbb-8bbb-000000000002";

    fn note(id: &str, title: &str, content: &str, updated_at: i64) -> SyncNote {
        SyncNote {
            id: id.into(),
            title: title.into(),
            content: content.into(),
            updated_at,
        }
    }

    /// A bare remote and two computers, isolated from the user's git config.
    struct World {
        root: tempfile::TempDir,
        state: GitSyncState,
    }

    impl World {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let config = root.path().join("gitconfig");
            fs::write(&config, "").unwrap();
            let state = GitSyncState {
                git: None,
                env: vec![
                    ("GIT_CONFIG_GLOBAL".into(), config.into_os_string()),
                    ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ],
                active: Mutex::default(),
            };
            let world = Self { root, state };
            world.git(
                &world.root.path().to_path_buf(),
                &["init", "-q", "--bare", "-b", "main", "remote.git"],
            );
            world
        }

        fn path(&self, name: &str) -> PathBuf {
            self.root.path().join(name)
        }

        fn remote(&self) -> String {
            self.path("remote.git").to_string_lossy().into_owned()
        }

        fn git(&self, folder: &PathBuf, args: &[&str]) -> String {
            let output = std::process::Command::new("git")
                .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
                .args(args)
                .current_dir(folder)
                .envs(self.state.env.iter().map(|(key, value)| (key, value)))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        async fn computer(&self, name: &str) -> PathBuf {
            let folder = self.path(name);
            let status = self
                .state
                .init(InitRequest {
                    folder: folder.to_string_lossy().into_owned(),
                    remote: Some(self.remote()),
                    branch: None,
                })
                .await
                .unwrap();
            assert!(status.git_installed && status.is_repo);
            assert_eq!(status.branch.as_deref(), Some("main"));
            folder
        }

        async fn sync(
            &self,
            folder: &Path,
            notes: Vec<SyncNote>,
            deleted: &[&str],
            known: &[&str],
            pull: bool,
            push: bool,
        ) -> GitSyncResult {
            let result = self
                .state
                .run(RunRequest {
                    folder: folder.to_string_lossy().into_owned(),
                    notes,
                    deleted_ids: deleted.iter().map(|id| id.to_string()).collect(),
                    known_ids: known.iter().map(|id| id.to_string()).collect(),
                    message: "TypeNext: test sync".into(),
                    pull,
                    push,
                })
                .await;
            assert_ne!(result.status, SyncStatus::Error, "{:?}", result.error);
            result
        }
    }

    fn files(folder: &Path) -> Vec<String> {
        list_note_files(folder)
    }

    #[tokio::test]
    async fn two_computers_share_edits_renames_deletions_and_conflicts() {
        let world = World::new();
        let a = world.computer("a").await;
        let b = world.computer("b").await;

        // First sync writes files, commits and pushes.
        let notes = vec![
            note(
                N1,
                "Hello World",
                "first line\r\nsecond line\n",
                1_760_000_000_123,
            ),
            note(N2, "Groceries", "milk\n", 1_760_000_001_000),
        ];
        let result = world
            .sync(&a, notes.clone(), &[], &[N1, N2], true, true)
            .await;
        assert_eq!(result.status, SyncStatus::Synced);
        assert!(result.committed && result.pushed && !result.pulled);
        assert!(result.remote_changes.is_empty());
        assert_eq!(
            files(&a),
            [
                "notes/groceries--22222222.md",
                "notes/hello-world--11111111.md"
            ]
        );
        let text = fs::read_to_string(a.join("notes/hello-world--11111111.md")).unwrap();
        assert_eq!(
            text,
            "---\ntypenext-id: 11111111-aaaa-4aaa-8aaa-000000000001\ntitle: \"Hello World\"\nupdated: 2025-10-09T08:53:20.123Z\n---\nfirst line\nsecond line\n"
        );
        assert_eq!(
            world
                .git(&world.path("remote.git"), &["rev-list", "--count", "main"])
                .trim(),
            "1"
        );
        let status = world
            .state
            .check(CheckRequest {
                folder: a.to_string_lossy().into_owned(),
            })
            .await
            .unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind, status.dirty), (0, 0, false));
        assert_eq!(status.last_commit.unwrap().message, "TypeNext: test sync");

        // Nothing changed: nothing to do, even when the same notes are sent.
        let result = world
            .sync(&a, notes.clone(), &[], &[N1, N2], true, true)
            .await;
        assert_eq!(result.status, SyncStatus::Nothing);
        assert!(!result.committed && !result.pushed && !result.pulled);

        // The second computer receives both notes.
        let result = world.sync(&b, Vec::new(), &[], &[], true, true).await;
        assert_eq!(result.status, SyncStatus::Synced);
        assert!(result.pulled);
        let mut received = result.remote_changes.clone();
        received.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(received.len(), 2);
        assert_eq!(received[0].id, N1);
        assert_eq!(received[0].title, "Hello World");
        assert_eq!(received[0].content, "first line\nsecond line\n");
        assert_eq!(received[0].updated_at, 1_760_000_000_123);
        let result = world.sync(&b, Vec::new(), &[], &[N1, N2], true, true).await;
        assert_eq!(result.status, SyncStatus::Nothing);

        // A new title moves the file.
        let renamed = note(
            N1,
            "Hello Git",
            "first line\nsecond line\n",
            1_760_000_002_000,
        );
        let result = world
            .sync(&a, vec![renamed], &[], &[N1, N2], true, true)
            .await;
        assert!(result.committed && result.pushed);
        assert_eq!(
            files(&a),
            [
                "notes/groceries--22222222.md",
                "notes/hello-git--11111111.md"
            ]
        );
        let result = world.sync(&b, Vec::new(), &[], &[N1, N2], true, true).await;
        assert_eq!(result.remote_changes.len(), 1);
        assert_eq!(result.remote_changes[0].title, "Hello Git");
        assert!(result.remote_deleted_ids.is_empty());
        assert_eq!(
            files(&b),
            [
                "notes/groceries--22222222.md",
                "notes/hello-git--11111111.md"
            ]
        );

        // An edit on the other computer comes back.
        let edited = note(N2, "Groceries", "milk\neggs\n", 1_760_000_003_000);
        world
            .sync(&b, vec![edited], &[], &[N1, N2], true, true)
            .await;
        let result = world.sync(&a, Vec::new(), &[], &[N1, N2], true, true).await;
        assert!(result.pulled && result.conflicts.is_empty());
        assert_eq!(
            result.remote_changes,
            [note(N2, "Groceries", "milk\neggs\n", 1_760_000_003_000)]
        );

        // Both computers edit the same note: local text wins in the
        // repository and the other version is returned, not lost.
        let local = note(N1, "Hello Git", "A version\n", 1_760_000_004_000);
        let result = world
            .sync(&a, vec![local], &[], &[N1, N2], false, false)
            .await;
        assert!(result.committed && !result.pushed);
        let remote = note(N1, "Hello Git", "B version\n", 1_760_000_005_000);
        world
            .sync(&b, vec![remote.clone()], &[], &[N1, N2], true, true)
            .await;
        let result = world.sync(&a, Vec::new(), &[], &[N1, N2], true, true).await;
        assert_eq!(result.status, SyncStatus::Synced);
        assert_eq!(result.conflicts, [remote]);
        assert!(result.remote_changes.iter().all(|note| note.id != N1));
        assert!(result.pushed);
        let text = fs::read_to_string(a.join("notes/hello-git--11111111.md")).unwrap();
        assert!(text.ends_with("---\nA version\n"), "{text}");
        let result = world.sync(&b, Vec::new(), &[], &[N1, N2], true, true).await;
        assert_eq!(result.remote_changes.len(), 1);
        assert_eq!(result.remote_changes[0].content, "A version\n");

        // A deletion propagates.
        let result = world.sync(&a, Vec::new(), &[N2], &[N1], true, true).await;
        assert!(result.committed && result.pushed);
        assert_eq!(files(&a), ["notes/hello-git--11111111.md"]);
        let result = world.sync(&b, Vec::new(), &[], &[N1, N2], true, true).await;
        assert_eq!(result.remote_deleted_ids, [N2]);
        assert_eq!(files(&b), ["notes/hello-git--11111111.md"]);

        // A file written by hand on another computer becomes a note.
        fs::write(b.join("notes/shopping-list.md"), "# Shopping\n\n- milk\n").unwrap();
        world.git(&b, &["add", "notes"]);
        world.git(&b, &["commit", "-q", "-m", "By hand"]);
        world.git(&b, &["push", "-q"]);
        let result = world.sync(&a, Vec::new(), &[], &[N1], true, true).await;
        assert_eq!(result.remote_changes.len(), 1);
        let imported = &result.remote_changes[0];
        assert_eq!(imported.id, derived_id("notes/shopping-list.md"));
        assert_eq!(imported.title, "Shopping");
        assert_eq!(imported.content, "# Shopping\n\n- milk\n");
        // Once known, the hand-written note is not reported again.
        let result = world
            .sync(&a, Vec::new(), &[], &[N1, &imported.id], true, true)
            .await;
        assert_eq!(result.status, SyncStatus::Nothing);
    }

    #[tokio::test]
    async fn a_new_computer_with_no_notes_adopts_the_remote_branch() {
        let world = World::new();
        let a = world.computer("a").await;
        world
            .sync(&a, vec![note(N1, "One", "1\n", 1)], &[], &[N1], true, true)
            .await;
        let fresh = world.computer("fresh").await;
        let result = world.sync(&fresh, Vec::new(), &[], &[], true, true).await;
        assert!(result.pulled);
        assert_eq!(result.remote_changes.len(), 1);
        assert_eq!(result.remote_changes[0].id, N1);
        let status = world
            .state
            .check(CheckRequest {
                folder: fresh.to_string_lossy().into_owned(),
            })
            .await
            .unwrap();
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    }

    #[tokio::test]
    async fn an_unreachable_remote_is_offline_and_keeps_the_local_commit() {
        let world = World::new();
        let folder = world.path("offline");
        let status = world
            .state
            .init(InitRequest {
                folder: folder.to_string_lossy().into_owned(),
                remote: Some("https://writer:secret-token@127.0.0.1:9/notes.git".into()),
                branch: Some("notes".into()),
            })
            .await
            .unwrap();
        assert_eq!(
            status.remote.as_deref(),
            Some("https://127.0.0.1:9/notes.git")
        );
        assert_eq!(status.branch.as_deref(), Some("notes"));
        let result = world
            .sync(
                &folder,
                vec![note(N1, "Draft", "text\n", 1)],
                &[],
                &[N1],
                true,
                true,
            )
            .await;
        assert_eq!(result.status, SyncStatus::Offline);
        assert!(result.committed && !result.pushed);
        let error = result.error.unwrap();
        assert!(
            !error.contains("secret-token") && !error.contains("writer"),
            "{error}"
        );
        assert_eq!(
            world.git(&folder, &["rev-list", "--count", "HEAD"]).trim(),
            "1"
        );
    }

    #[tokio::test]
    async fn a_missing_git_binary_is_reported_without_failing() {
        let directory = tempfile::tempdir().unwrap();
        let state = GitSyncState {
            git: Some(directory.path().join("no-such-git")),
            ..GitSyncState::default()
        };
        let folder = directory.path().to_string_lossy().into_owned();
        let status = state
            .check(CheckRequest {
                folder: folder.clone(),
            })
            .await
            .unwrap();
        assert!(!status.git_installed && status.folder_exists && !status.is_repo);
        let result = state
            .run(RunRequest {
                folder: folder.clone(),
                notes: Vec::new(),
                deleted_ids: Vec::new(),
                known_ids: Vec::new(),
                message: String::new(),
                pull: true,
                push: true,
            })
            .await;
        assert_eq!(result.status, SyncStatus::Error);
        assert!(result.error.unwrap().contains("not installed"));
        let error = state
            .init(InitRequest {
                folder,
                remote: None,
                branch: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("not installed"), "{error}");
    }

    #[tokio::test]
    async fn a_second_sync_of_the_same_folder_is_busy() {
        let world = World::new();
        let folder = world.computer("a").await;
        let _running = world.state.try_busy(&folder).unwrap();
        let result = world
            .state
            .run(RunRequest {
                folder: folder.to_string_lossy().into_owned(),
                notes: Vec::new(),
                deleted_ids: Vec::new(),
                known_ids: Vec::new(),
                message: String::new(),
                pull: false,
                push: false,
            })
            .await;
        assert_eq!(result.status, SyncStatus::Busy);
        assert!(world.state.try_busy(&world.path("other")).is_some());
    }

    #[tokio::test]
    async fn init_keeps_an_existing_remote_and_attributes() {
        let world = World::new();
        let folder = world.computer("a").await;
        let again = world.computer("a").await;
        assert_eq!(again, folder);
        let attributes = fs::read_to_string(folder.join(".gitattributes")).unwrap();
        assert_eq!(attributes, "*.md text eol=lf\n");
        let error = world
            .state
            .init(InitRequest {
                folder: folder.to_string_lossy().into_owned(),
                remote: Some("https://example.com/other.git".into()),
                branch: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("already syncs"), "{error}");
        let error = world
            .state
            .init(InitRequest {
                folder: folder.to_string_lossy().into_owned(),
                remote: Some("ext::sh -c touch% /tmp/pwned".into()),
                branch: None,
            })
            .await
            .unwrap_err();
        assert!(error.contains("https://"), "{error}");
        // A folder inside another repository is not that repository.
        let nested = folder.join("notes");
        let status = world
            .state
            .check(CheckRequest {
                folder: nested.to_string_lossy().into_owned(),
            })
            .await
            .unwrap();
        assert!(!status.is_repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_in_notes_are_never_followed() {
        let world = World::new();
        let folder = world.computer("a").await;
        let outside = world.path("outside.md");
        fs::write(&outside, "keep me").unwrap();
        fs::create_dir_all(folder.join("notes")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("notes/linked.md")).unwrap();
        std::os::unix::fs::symlink(&outside, folder.join("notes/hello--11111111.md")).unwrap();
        let result = world
            .sync(
                &folder,
                vec![note(N1, "Hello", "new\n", 1)],
                &[],
                &[N1],
                false,
                false,
            )
            .await;
        assert!(result.committed);
        // The written note replaced its symlink; the target is untouched.
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep me");
        assert!(
            fs::symlink_metadata(folder.join("notes/hello--11111111.md"))
                .unwrap()
                .is_file()
        );
        // The other symlink is not read as a note.
        assert!(result.remote_changes.is_empty());
    }

    #[test]
    fn note_paths_stay_inside_the_notes_folder() {
        assert!(note_path_ok("notes/hello--11111111.md"));
        for path in [
            "notes/../escape.md",
            "notes/sub/dir.md",
            "../notes/x.md",
            "notes/.hidden.md",
            "notes/x.txt",
            "notes/",
            "notes\\x.md",
            "other/x.md",
        ] {
            assert!(!note_path_ok(path), "{path}");
        }
    }

    #[test]
    fn slugs_are_short_lowercase_ascii() {
        assert_eq!(slug("Hello, World!"), "hello-world");
        assert_eq!(slug("  Plan: Q4 / 2026  "), "plan-q4-2026");
        assert_eq!(slug("Café crème"), "caf-cr-me");
        assert_eq!(slug("日本語"), "untitled");
        assert_eq!(slug(""), "untitled");
        assert_eq!(slug(&"a".repeat(80)).len(), 60);
        assert!(!slug(&format!("{} b", "a".repeat(59))).ends_with('-'));
        let note = note(N1, "../../etc/passwd", "", 0);
        assert_eq!(note_path(&note, 8), "notes/etc-passwd--11111111.md");
    }

    #[test]
    fn rfc3339_round_trips_milliseconds() {
        assert_eq!(format_rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339(1_760_000_000_123),
            "2025-10-09T08:53:20.123Z"
        );
        assert_eq!(format_rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
        for ms in [0, 1, 951_782_400_000, 1_760_000_000_123, 4_102_444_799_999] {
            assert_eq!(parse_rfc3339(&format_rfc3339(ms)), Some(ms));
        }
        assert_eq!(
            parse_rfc3339("2025-10-09T10:53:20+02:00"),
            Some(1_760_000_000_000)
        );
        assert_eq!(
            parse_rfc3339("2025-10-09T08:53:20.5Z"),
            Some(1_760_000_000_500)
        );
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2025-13-09T08:53:20Z"), None);
    }

    #[test]
    fn front_matter_round_trips_and_hand_written_files_get_stable_ids() {
        let original = note(
            N1,
            "Quotes \"and\"\nnew lines: yes",
            "body\r\n---\nmore\n",
            1_760_000_000_123,
        );
        let parsed = parse_front_matter(&render(&original)).unwrap();
        assert_eq!(parsed.title, original.title);
        assert_eq!(parsed.content, "body\n---\nmore\n");
        assert_eq!(parsed.updated_at, original.updated_at);
        assert!(parse_front_matter("# Just markdown\n").is_none());
        assert!(parse_front_matter("---\ntitle: x\n---\nno id\n").is_none());
        assert!(parse_front_matter("---\ntypenext-id: ../x\n---\n").is_none());
        let hand = note_from_file("notes/weekly-plan.md", "Some text\n", 42);
        assert_eq!(hand.title, "weekly plan");
        assert_eq!(hand.updated_at, 42);
        assert_eq!(hand.id, derived_id("notes/weekly-plan.md"));
        assert_eq!(hand.id.len(), 36);
        assert!(validate_id(&hand.id));
        assert_ne!(hand.id, derived_id("notes/other.md"));
    }

    #[test]
    fn remotes_are_validated_and_credentials_redacted() {
        for remote in [
            "https://github.com/writer/notes.git",
            "ssh://git@github.com/writer/notes.git",
            "git@github.com:writer/notes.git",
            "file:///srv/notes.git",
            "file:///C:/Users/writer/notes.git",
        ] {
            assert!(validate_remote(remote).is_ok(), "{remote}");
        }
        for remote in [
            "file://",
            "file://notes.git",
            "file:///-upload",
            "file:///my notes",
        ] {
            assert!(validate_remote(remote).is_err(), "{remote}");
        }
        #[cfg(unix)]
        assert!(validate_remote("/Volumes/Backup/notes.git").is_ok());
        for remote in [
            "ext::sh -c evil",
            "fd::17",
            "--upload-pack=evil",
            "-oProxyCommand=evil",
            "http://example.com/notes.git",
            "git://example.com/notes.git",
            "relative/path",
            "git@-oProxyCommand=evil:x",
            "https://exa mple.com/x",
            "",
        ] {
            assert!(validate_remote(remote).is_err(), "{remote}");
        }
        assert_eq!(
            redact("fatal: unable to access 'https://writer:tok@github.com/x.git/': 403"),
            "fatal: unable to access 'https://github.com/x.git/': 403"
        );
        assert_eq!(redact("ssh://git@host/x"), "ssh://host/x");
        assert_eq!(
            git_message("remote: nope\nfatal: unable to access 'https://a:b@h/x': refused\n"),
            "unable to access 'https://h/x': refused"
        );
        assert!(is_offline(
            "fatal: unable to access 'https://h/': Could not resolve host: h"
        ));
        assert!(!is_offline("error: pathspec 'x' did not match"));
        assert!(validate_branch("main").is_ok() && validate_branch("notes/2026").is_ok());
        for branch in ["", "-x", "a..b", "a b", "x.lock", "a@{1}"] {
            assert!(validate_branch(branch).is_err(), "{branch}");
        }
    }

    #[test]
    fn oversized_or_invalid_requests_are_refused() {
        let request = |notes: Vec<SyncNote>| RunRequest {
            folder: "/x".into(),
            notes,
            deleted_ids: Vec::new(),
            known_ids: Vec::new(),
            message: String::new(),
            pull: false,
            push: false,
        };
        assert!(validate_run(&request(vec![note(N1, "a", "b", 0)])).is_ok());
        assert!(
            validate_run(&request(vec![note(N1, "a", "b", 0), note(N1, "c", "d", 0)])).is_err()
        );
        assert!(validate_run(&request(vec![note("../x", "a", "b", 0)])).is_err());
        assert!(validate_run(&request(vec![note(
            N1,
            "a",
            &"x".repeat(MAX_NOTE_BYTES + 1),
            0
        )]))
        .is_err());
        assert!(validate_run(&request(
            (0..=MAX_NOTES)
                .map(|i| note(&format!("n{i}"), "", "", 0))
                .collect()
        ))
        .is_err());
        assert!(validate_folder("relative/folder").is_err());
    }
}
