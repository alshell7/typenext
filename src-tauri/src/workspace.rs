use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

const MAX_WORKSPACE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_MARKDOWN_BYTES: usize = 8 * 1024 * 1024;
const PROVIDERS: [&str; 5] = ["openrouter", "openai", "anthropic", "local", "custom"];

#[derive(Default)]
pub struct WorkspaceState {
    lock: Arc<Mutex<()>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    version: u8,
    notes: Vec<Note>,
    #[serde(default)]
    context_library: Vec<ContextSource>,
    open_note_ids: Vec<String>,
    active_note_id: Option<String>,
    settings: Settings,
}

#[derive(Serialize)]
pub struct LoadedWorkspace {
    #[serde(flatten)]
    workspace: Workspace,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovered: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    title: String,
    objective: String,
    context: String,
    content: String,
    sources: Vec<ContextSource>,
    created_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exported_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContextSource {
    id: String,
    name: String,
    kind: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linked_note_id: Option<String>,
    #[serde(default)]
    library_id: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    enabled: bool,
    added_at: u64,
}

impl Serialize for ContextSource {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let fields = 6
            + usize::from(self.origin.is_some())
            + usize::from(self.linked_note_id.is_some())
            + usize::from(self.library_id.is_some())
            + usize::from(self.folder.is_some());
        let mut source = serializer.serialize_struct("ContextSource", fields)?;
        source.serialize_field("id", &self.id)?;
        source.serialize_field("name", &self.name)?;
        source.serialize_field("kind", &self.kind)?;
        source.serialize_field(
            "text",
            if self.kind == "note" || self.library_id.is_some() {
                ""
            } else {
                &self.text
            },
        )?;
        if let Some(origin) = &self.origin {
            source.serialize_field("origin", origin)?;
        }
        if let Some(linked_note_id) = &self.linked_note_id {
            source.serialize_field("linkedNoteId", linked_note_id)?;
        }
        if let Some(library_id) = &self.library_id {
            source.serialize_field("libraryId", library_id)?;
        }
        if let Some(folder) = &self.folder {
            source.serialize_field("folder", folder)?;
        }
        source.serialize_field("enabled", &self.enabled)?;
        source.serialize_field("addedAt", &self.added_at)?;
        source.end()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    theme: String,
    #[serde(default)]
    palette: Palette,
    font_family: String,
    font_size: f64,
    auto_save: bool,
    suggestions_enabled: bool,
    auto_suggest: bool,
    temperature: f64,
    suggestion_delay: f64,
    max_tokens: f64,
    #[serde(default = "default_suggestion_length")]
    suggestion_length: String,
    provider: String,
    #[serde(default)]
    external_auto_enabled: bool,
    #[serde(default)]
    suggestion_instructions: String,
    #[serde(default = "default_local_engine")]
    local_engine: String,
    #[serde(default = "default_external_provider")]
    external_provider: String,
    profiles: HashMap<String, ProviderProfile>,
    website_importer: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct ProviderProfile {
    #[serde(default, rename = "savedModels")]
    saved_models: Vec<String>,
    endpoint: String,
    model: String,
    protocol: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Palette {
    light: String,
    dark: String,
    custom_light: PaletteColors,
    custom_dark: PaletteColors,
}

#[derive(Debug, Deserialize, Serialize)]
struct PaletteColors {
    page: String,
    sidebar: String,
    accent: String,
}

impl Default for Palette {
    fn default() -> Self {
        Self {
            light: "paper".into(),
            dark: "graphite".into(),
            custom_light: PaletteColors {
                page: "#ffffff".into(),
                sidebar: "#f3f4f1".into(),
                accent: "#42644d".into(),
            },
            custom_dark: PaletteColors {
                page: "#212121".into(),
                sidebar: "#17191c".into(),
                accent: "#a6b6c8".into(),
            },
        }
    }
}

fn validate_palette(palette: &Palette) -> Result<(), String> {
    if !matches!(
        palette.light.as_str(),
        "paper" | "linen" | "mist" | "contrast" | "custom"
    ) || !matches!(
        palette.dark.as_str(),
        "graphite" | "midnight" | "forest" | "black" | "contrast" | "custom"
    ) {
        return Err("The notebook contains an invalid color palette".into());
    }
    for colors in [&palette.custom_light, &palette.custom_dark] {
        for color in [&colors.page, &colors.sidebar, &colors.accent] {
            if color.len() != 7
                || !color.starts_with('#')
                || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err("Custom colors must use #RRGGBB hex values".into());
            }
        }
    }
    Ok(())
}

fn default_local_engine() -> String {
    "server".into()
}

fn default_suggestion_length() -> String {
    "adaptive".into()
}
fn default_external_provider() -> String {
    "openrouter".into()
}

fn bounded_text(text: &str, max: usize, field: &str) -> Result<(), String> {
    if text.len() > max {
        return Err(format!("{field} exceeds its supported size"));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err("The notebook contains an invalid identifier".into());
    }
    Ok(())
}

fn validate_workspace(workspace: &Workspace) -> Result<(), String> {
    if workspace.version != 1 {
        return Err("This notebook version is not supported by this release".into());
    }
    if workspace.notes.len() > 10_000 {
        return Err("The notebook exceeds the supported number of notes".into());
    }
    let mut ids = HashSet::new();
    for note in &workspace.notes {
        validate_id(&note.id)?;
        if !ids.insert(&note.id) {
            return Err("The notebook contains duplicate notes".into());
        }
        bounded_text(&note.title, 4096, "Note title")?;
        bounded_text(&note.objective, 65_536, "Note objective")?;
        bounded_text(&note.context, 1024 * 1024, "Note context")?;
        bounded_text(&note.content, MAX_MARKDOWN_BYTES, "Note text")?;
        if let Some(path) = &note.file_path {
            bounded_text(path, 32_768, "File path")?;
        }
        if note.sources.len() > 256 {
            return Err("A note exceeds the supported number of context sources".into());
        }
        let mut source_ids = HashSet::new();
        let mut linked_ids = HashSet::new();
        for source in &note.sources {
            validate_id(&source.id)?;
            if !source_ids.insert(&source.id) {
                return Err("A note contains duplicate context sources".into());
            }
            if !matches!(
                source.kind.as_str(),
                "text" | "markdown" | "pdf" | "docx" | "website" | "note"
            ) {
                return Err("A context source has an unsupported format".into());
            }
            if source.kind == "note" {
                let linked_id = source
                    .linked_note_id
                    .as_deref()
                    .ok_or("A linked context source is missing its note identifier")?;
                validate_id(linked_id)?;
                if !linked_ids.insert(linked_id) {
                    return Err("A note contains duplicate linked references".into());
                }
            } else if source.linked_note_id.is_some() {
                return Err("Only linked-note sources may contain a note identifier".into());
            }
            if let Some(library_id) = &source.library_id {
                validate_id(library_id)?;
            }
            if let Some(folder) = &source.folder {
                bounded_text(folder, 4096, "Source folder")?;
            }
            bounded_text(&source.name, 4096, "Source name")?;
            bounded_text(&source.text, MAX_MARKDOWN_BYTES, "Source text")?;
            if let Some(origin) = &source.origin {
                bounded_text(origin, 32_768, "Source origin")?;
            }
        }
    }
    if workspace.context_library.len() > 2048 {
        return Err("The context library exceeds 2048 references".into());
    }
    let mut library_ids = HashSet::new();
    for source in &workspace.context_library {
        validate_id(&source.id)?;
        if !library_ids.insert(&source.id) || source.library_id.is_some() {
            return Err("The library contains duplicate or nested references".into());
        }
        if !matches!(
            source.kind.as_str(),
            "text" | "markdown" | "pdf" | "docx" | "website" | "note"
        ) {
            return Err("A library reference has an unsupported format".into());
        }
        if source.kind == "note" {
            validate_id(
                source
                    .linked_note_id
                    .as_deref()
                    .ok_or("A library note link needs an identifier")?,
            )?;
        } else if source.linked_note_id.is_some() {
            return Err("Only notes may have a linked note identifier".into());
        }
        bounded_text(&source.name, 4096, "Source name")?;
        bounded_text(&source.text, MAX_MARKDOWN_BYTES, "Source text")?;
        if let Some(origin) = &source.origin {
            bounded_text(origin, 32_768, "Source origin")?;
        }
        if let Some(folder) = &source.folder {
            bounded_text(folder, 4096, "Source folder")?;
        }
    }
    let mut open_ids = HashSet::new();
    for id in &workspace.open_note_ids {
        if !ids.contains(id) || !open_ids.insert(id) {
            return Err("The notebook contains an invalid tab".into());
        }
    }
    if let Some(id) = &workspace.active_note_id {
        if !open_ids.contains(id) {
            return Err("The active note is missing from the open tabs".into());
        }
    }
    let settings = &workspace.settings;
    validate_palette(&settings.palette)?;
    if !matches!(settings.theme.as_str(), "light" | "dark" | "system")
        || !PROVIDERS.contains(&settings.provider.as_str())
        || !matches!(
            settings.suggestion_length.as_str(),
            "adaptive" | "short" | "sentence"
        )
        || !matches!(
            settings.external_provider.as_str(),
            "openrouter" | "openai" | "anthropic" | "custom"
        )
        || !matches!(settings.website_importer.as_str(), "direct" | "firecrawl")
        || !(8.0..=72.0).contains(&settings.font_size)
        || !(0.0..=2.0).contains(&settings.temperature)
        || !(100.0..=10_000.0).contains(&settings.suggestion_delay)
        || !(8.0..=2048.0).contains(&settings.max_tokens)
    {
        return Err("The notebook contains invalid preferences".into());
    }
    if !matches!(
        settings.local_engine.as_str(),
        "recall" | "embedded" | "server"
    ) {
        return Err("Invalid local suggestion engine".into());
    }
    bounded_text(
        &settings.suggestion_instructions,
        8000,
        "Suggestion instructions",
    )?;
    bounded_text(&settings.font_family, 256, "Font preference")?;
    if settings.profiles.len() != PROVIDERS.len() {
        return Err("Provider preferences are incomplete".into());
    }
    for provider in PROVIDERS {
        let profile = settings
            .profiles
            .get(provider)
            .ok_or("Provider preferences are incomplete")?;
        if profile.saved_models.len() > 32 {
            return Err("Too many saved models".into());
        }
        for model in &profile.saved_models {
            bounded_text(model, 256, "Saved model")?;
        }
        bounded_text(&profile.endpoint, 4096, "Provider endpoint")?;
        bounded_text(&profile.model, 256, "Provider model")?;
        if !matches!(profile.protocol.as_str(), "chat" | "fim") {
            return Err("The completion protocol is not supported".into());
        }
    }
    Ok(())
}

/// The previous file remains readable until a complete sibling file is synced
/// and atomically replaces it. A successful return includes the rename barrier.
fn atomic_write_with(
    path: &Path,
    write: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("The destination has no parent directory")?;
    let prefix = format!(
        ".{}.pending-",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    let mut file = tempfile::Builder::new()
        .prefix(&prefix)
        .tempfile_in(directory)
        .map_err(|error| format!("Could not prepare a safe save: {error}"))?;
    write(file.as_file_mut())?;
    save_checkpoint(path, "written");
    file.as_file()
        .sync_all()
        .map_err(|error| format!("Could not sync the saved note: {error}"))?;
    save_checkpoint(path, "synced");
    let file = replace_file(file, path, true)?;
    save_checkpoint(path, "replaced");
    #[cfg(unix)]
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync the notebook directory: {error}"))?;
    // fsync alone does not flush the drive's volatile cache on macOS.
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: file owns a live descriptor. F_FULLFSYNC takes no argument.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } == -1 {
            return Err(format!(
                "Could not flush the saved note to disk: {}",
                io::Error::last_os_error()
            ));
        }
    }
    drop(file);
    save_checkpoint(path, "durable");
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn replace_file(
    file: tempfile::NamedTempFile,
    path: &Path,
    overwrite: bool,
) -> Result<File, String> {
    let result = if overwrite {
        file.persist(path)
    } else {
        file.persist_noclobber(path)
    };
    result.map_err(|error| format!("Could not finish saving the note: {}", error.error))
}

#[cfg(target_os = "windows")]
fn replace_file(
    file: tempfile::NamedTempFile,
    path: &Path,
    overwrite: bool,
) -> Result<File, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH,
    };
    let old: Vec<u16> = file
        .path()
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let new: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // tempfile uses TEMPORARY attributes while writing; the retained file is a
    // normal durable document once it is committed.
    // SAFETY: old is a live, NUL-terminated buffer for the owned temporary file.
    if unsafe { SetFileAttributesW(old.as_ptr(), FILE_ATTRIBUTE_NORMAL) } == 0 {
        return Err(format!(
            "Could not prepare the saved note: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: both buffers are NUL-terminated and live for the call. The sibling
    // temp file is on the same volume; COPY_ALLOWED is deliberately absent.
    if unsafe {
        MoveFileExW(
            old.as_ptr(),
            new.as_ptr(),
            MOVEFILE_WRITE_THROUGH
                | if overwrite {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                },
        )
    } == 0
    {
        return Err(format!(
            "Could not finish saving the note: {}",
            io::Error::last_os_error()
        ));
    }
    let (file, old_path) = file.into_parts();
    // The old path no longer exists. Keeping it must not create an orphan file.
    let _ = old_path.keep();
    Ok(file)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_with(path, |file| {
        file.write_all(bytes)
            .map_err(|error| format!("Could not write the note: {error}"))
    })
}

// Only the isolated crash-test executable activates this hook. Production has
// no environment-driven fault injection or checkpoint I/O.
#[cfg(not(test))]
fn save_checkpoint(_: &Path, _: &str) {}

#[cfg(test)]
fn save_checkpoint(path: &Path, phase: &str) {
    let Ok(expected) = std::env::var("TYPENEXT_TEST_SAVE_CHECKPOINT") else {
        return;
    };
    let actual = format!(
        "{}:{phase}",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
    if actual != expected {
        return;
    }
    let marker = std::env::var_os("TYPENEXT_TEST_SAVE_MARKER").unwrap();
    fs::write(marker, actual).unwrap();
    loop {
        std::thread::park();
    }
}

fn read_workspace(path: &Path) -> Result<Workspace, String> {
    let file = File::open(path).map_err(|error| format!("Could not read the notebook: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > MAX_WORKSPACE_BYTES as u64 {
        return Err("The notebook exceeds the supported size (64 MB)".into());
    }
    // Parsing a bounded contiguous buffer avoids serde's per-byte reader
    // overhead. The buffer is dropped before any recovery copy is written.
    let mut bytes = Vec::with_capacity(length as usize + 1);
    file.take((MAX_WORKSPACE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read the notebook: {error}"))?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err("The notebook exceeds the supported size (64 MB)".into());
    }
    let mut workspace: Workspace = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The notebook file could not be parsed: {error}"))?;
    // Old provider preferences cannot opt the writer into remote suggestions.
    if !workspace.settings.external_auto_enabled {
        workspace.settings.provider = "local".into();
    }
    for note in &mut workspace.notes {
        for source in &mut note.sources {
            if source.kind == "note" || source.library_id.is_some() {
                source.text.clear();
            }
        }
    }
    validate_workspace(&workspace)?;
    Ok(workspace)
}

struct BoundedWriter<W> {
    inner: W,
    remaining: usize,
}

impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::other(
                "The notebook exceeds the supported size (64 MB)",
            ));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn write_workspace(path: &Path, workspace: &Workspace) -> Result<(), String> {
    validate_workspace(workspace)?;
    atomic_write_with(path, |file| {
        let mut writer = io::BufWriter::new(BoundedWriter {
            inner: file,
            remaining: MAX_WORKSPACE_BYTES,
        });
        serde_json::to_writer(&mut writer, workspace).map_err(|error| error.to_string())?;
        writer
            .flush()
            .map_err(|error| format!("Could not write the notebook: {error}"))
    })
}

fn preserve_corrupt_primary(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let directory = path.parent().ok_or("The notebook folder is unavailable")?;
    let mut original = File::open(path)
        .map_err(|error| format!("Could not preserve the damaged notebook: {error}"))?;
    let mut archive = tempfile::Builder::new()
        .prefix("workspace-v1.corrupt-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .map_err(|error| format!("Could not preserve the damaged notebook: {error}"))?;
    io::copy(&mut original, archive.as_file_mut())
        .map_err(|error| format!("Could not preserve the damaged notebook: {error}"))?;
    archive
        .as_file()
        .sync_all()
        .map_err(|error| format!("Could not sync the damaged notebook recovery file: {error}"))?;
    // A random, exclusively created sibling supplies a unique archive name.
    // Commit this copy before anything can replace the primary file.
    let archive_path = archive.path().with_extension("json");
    let file = replace_file(archive, &archive_path, false)?;
    #[cfg(unix)]
    File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync the recovery directory: {error}"))?;
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // SAFETY: the retained file owns a live descriptor.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) } == -1 {
            return Err(format!(
                "Could not flush the recovery file: {}",
                io::Error::last_os_error()
            ));
        }
    }
    drop(file);
    Ok(())
}

fn paths(directory: &Path) -> (PathBuf, PathBuf) {
    (
        directory.join("workspace-v1.json"),
        directory.join("workspace-v1.backup.json"),
    )
}

fn interrupted_workspace(directory: &Path) -> Result<Option<Workspace>, String> {
    if !directory.exists() {
        return Ok(None);
    }
    let mut pending = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect the recovery folder: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".workspace-v1.json.pending-")
        {
            // A bounded scan protects startup from an unexpectedly huge folder.
            if pending.len() == 256 {
                return Err("Too many interrupted save files remain in the app data folder. Preserve or repair those files before continuing.".into());
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            pending.push((modified, entry.path()));
        }
    }
    pending.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    for (_, path) in &pending {
        if let Ok(workspace) = read_workspace(path) {
            return Ok(Some(workspace));
        }
    }
    if !pending.is_empty() {
        return Err("An interrupted notebook save remains in the app data folder, but no complete copy could be read. Your temporary files are preserved; repair or export them before continuing.".into());
    }
    Ok(None)
}

fn load_at_path(directory: &Path) -> Result<(Option<Workspace>, bool), String> {
    let (primary, backup) = paths(directory);
    let absent = !primary.exists() && !backup.exists();
    if let Ok(workspace) = read_workspace(&primary) {
        return Ok((Some(workspace), false));
    }
    if let Ok(workspace) = read_workspace(&backup) {
        preserve_corrupt_primary(&primary)?;
        write_workspace(&primary, &workspace)?;
        return Ok((Some(workspace), true));
    }
    // The very first save can die before a primary or backup exists. Only use
    // abandoned primary temps when neither committed snapshot can be read.
    if let Some(workspace) = interrupted_workspace(directory)? {
        preserve_corrupt_primary(&primary)?;
        write_workspace(&primary, &workspace)?;
        return Ok((Some(workspace), true));
    }
    if absent {
        return Ok((None, false));
    }
    Err("The notebook and its recovery copy could not be read. Your files remain in the app data folder; export or restore a valid copy before starting a new notebook.".into())
}

fn persist_at_path(directory: &Path, workspace: &Workspace) -> Result<(), String> {
    validate_workspace(workspace)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the notebook folder: {error}"))?;
    let (primary, backup) = paths(directory);
    // Never replace a valid recovery copy with a corrupt primary file.
    if let Ok(previous) = read_workspace(&primary) {
        write_workspace(&backup, &previous)?;
    } else {
        preserve_corrupt_primary(&primary)?;
    }
    write_workspace(&primary, workspace)
}

#[tauri::command]
pub async fn open_workspace_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        app.opener()
            .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_workspace(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
) -> Result<Option<LoadedWorkspace>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let lock = state.lock.clone();
    let (workspace, recovered) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "The notebook save lock is unavailable")?;
        load_at_path(&directory)
    })
    .await
    .map_err(|error| error.to_string())??;
    if recovered {
        let _ = app.emit("workspace-recovered", ());
    }
    Ok(workspace.map(|workspace| LoadedWorkspace {
        workspace,
        recovered: recovered.then_some(true),
    }))
}

#[tauri::command]
pub async fn persist_workspace(
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    mut workspace: Workspace,
) -> Result<(), String> {
    if !workspace.settings.external_auto_enabled {
        workspace.settings.provider = "local".into();
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let lock = state.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "The notebook save lock is unavailable")?;
        persist_at_path(&directory, &workspace)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_markdown_path(path: &Path, content: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Select an absolute Markdown file path using the save dialog".into());
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !["md", "markdown", "txt"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err("Use an .md, .markdown or .txt file for this note".into());
    }
    if content.len() > MAX_MARKDOWN_BYTES {
        return Err("This note exceeds the supported export size (8 MB)".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn write_markdown_file(
    app: AppHandle,
    path: PathBuf,
    content: String,
) -> Result<String, String> {
    if !app.fs_scope().is_allowed(&path) {
        return Err("Access to this file has not been granted. Use Save As to select it.".into());
    }
    let target = if path.extension().is_none() {
        path.with_extension("md")
    } else {
        path.clone()
    };
    validate_markdown_path(&target, &content)?;
    if target != path {
        app.fs_scope()
            .allow_file(&target)
            .map_err(|error| error.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        atomic_write(&target, content.as_bytes())?;
        Ok(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn example(text: &str) -> Workspace {
        serde_json::from_value(json!({
            "version": 1,
            "notes": [{ "id": "note-1", "title": "My note", "objective": "", "context": "", "content": text, "sources": [], "createdAt": 1, "updatedAt": 2 }],
            "openNoteIds": ["note-1"], "activeNoteId": "note-1",
            "settings": {
                "theme": "system", "fontFamily": "Merriweather", "fontSize": 16,
                "autoSave": true, "suggestionsEnabled": true, "autoSuggest": true,
                "temperature": 0.3, "suggestionDelay": 800, "maxTokens": 96,
                "provider": "local", "websiteImporter": "direct", "profiles": {
                    "openrouter": { "endpoint": "", "model": "", "protocol": "chat" },
                    "openai": { "endpoint": "", "model": "", "protocol": "chat" },
                    "anthropic": { "endpoint": "", "model": "", "protocol": "chat" },
                    "local": { "endpoint": "http://localhost:1234/v1", "model": "", "protocol": "fim" },
                    "custom": { "endpoint": "", "model": "", "protocol": "chat" }
                }
            }
        })).unwrap()
    }

    #[test]
    fn saves_replace_an_existing_file_and_preserve_previous_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &example("First draft")).unwrap();
        persist_at_path(directory.path(), &example("Second draft")).unwrap();
        let (primary, backup) = paths(directory.path());
        assert_eq!(
            read_workspace(&primary).unwrap().notes[0].content,
            "Second draft"
        );
        assert_eq!(
            read_workspace(&backup).unwrap().notes[0].content,
            "First draft"
        );
    }

    #[test]
    fn corrupt_primary_recovers_and_restores_the_previous_valid_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &example("First draft")).unwrap();
        persist_at_path(directory.path(), &example("Second draft")).unwrap();
        let (primary, _) = paths(directory.path());
        fs::write(&primary, "{incomplete").unwrap();
        let (workspace, recovered) = load_at_path(directory.path()).unwrap();
        assert!(recovered);
        assert_eq!(workspace.unwrap().notes[0].content, "First draft");
        assert_eq!(
            read_workspace(&primary).unwrap().notes[0].content,
            "First draft"
        );
        let archived: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("workspace-v1.corrupt-")
            })
            .collect();
        assert_eq!(archived.len(), 1);
        assert_eq!(fs::read_to_string(&archived[0]).unwrap(), "{incomplete");
    }

    #[test]
    fn saving_after_corruption_does_not_destroy_the_recovery_copy() {
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &example("First draft")).unwrap();
        persist_at_path(directory.path(), &example("Second draft")).unwrap();
        let (primary, backup) = paths(directory.path());
        fs::write(&primary, "invalid").unwrap();
        persist_at_path(directory.path(), &example("Recovered draft")).unwrap();
        assert_eq!(
            read_workspace(&backup).unwrap().notes[0].content,
            "First draft"
        );
        let archived: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("workspace-v1.corrupt-")
            })
            .collect();
        assert_eq!(archived.len(), 1);
        assert_eq!(fs::read_to_string(&archived[0]).unwrap(), "invalid");
    }

    #[test]
    fn invalid_state_cannot_replace_a_valid_saved_notebook() {
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &example("Keep this")).unwrap();
        let mut invalid = example("Wrong");
        invalid.active_note_id = Some("missing-note".into());
        assert!(persist_at_path(directory.path(), &invalid).is_err());
        assert_eq!(
            load_at_path(directory.path()).unwrap().0.unwrap().notes[0].content,
            "Keep this"
        );
        invalid = example("Wrong");
        invalid.settings.temperature = f64::NAN;
        assert!(validate_workspace(&invalid).is_err());
    }

    #[test]
    fn absent_notebook_is_empty_but_corruption_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        assert!(load_at_path(directory.path()).unwrap().0.is_none());
        fs::write(paths(directory.path()).0, "invalid").unwrap();
        assert!(load_at_path(directory.path()).is_err());
    }

    #[test]
    fn markdown_export_rejects_relative_paths_and_other_extensions() {
        assert!(validate_markdown_path(Path::new("../draft.md"), "text").is_err());
        let directory = tempfile::tempdir().unwrap();
        assert!(validate_markdown_path(&directory.path().join("draft.exe"), "text").is_err());
        assert!(validate_markdown_path(&directory.path().join("draft.MD"), "text").is_ok());
    }

    fn linked_source(id: &str, target: Option<&str>) -> ContextSource {
        ContextSource {
            id: id.into(),
            name: "Reference note".into(),
            kind: "note".into(),
            text: "Derived writing must not be cached".into(),
            origin: None,
            linked_note_id: target.map(str::to_string),
            library_id: None,
            folder: None,
            enabled: true,
            added_at: 1,
        }
    }

    #[test]
    fn reusable_context_and_explicit_engine_selection_survive_native_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = example("My writing");
        let mut canonical = linked_source("shared", Some("reference-note"));
        canonical.kind = "text".into();
        canonical.linked_note_id = None;
        canonical.text = "Only one stored copy".into();
        canonical.folder = Some("Research/Ideas".into());
        let mut reference = linked_source("shared", Some("reference-note"));
        reference.kind = "text".into();
        reference.linked_note_id = None;
        reference.library_id = Some("shared".into());
        workspace.context_library.push(canonical);
        workspace.notes[0].sources.push(reference);
        workspace.settings.provider = "openai".into();
        workspace.settings.external_auto_enabled = true;
        workspace.settings.local_engine = "embedded".into();
        workspace.settings.suggestion_instructions = "Keep my voice".into();
        workspace.settings.palette.dark = "black".into();
        workspace
            .settings
            .profiles
            .get_mut("openai")
            .unwrap()
            .saved_models = vec!["writer-a".into(), "writer-b".into()];
        persist_at_path(directory.path(), &workspace).unwrap();
        let restored = load_at_path(directory.path()).unwrap().0.unwrap();
        assert_eq!(restored.settings.provider, "openai");
        assert!(restored.settings.external_auto_enabled);
        assert_eq!(restored.settings.local_engine, "embedded");
        assert_eq!(restored.settings.suggestion_instructions, "Keep my voice");
        assert_eq!(restored.settings.profiles["openai"].saved_models.len(), 2);
        assert_eq!(restored.context_library[0].text, "Only one stored copy");
        assert_eq!(
            restored.context_library[0].folder.as_deref(),
            Some("Research/Ideas")
        );
        assert_eq!(restored.notes[0].sources[0].text, "");
        assert_eq!(
            restored.notes[0].sources[0].library_id.as_deref(),
            Some("shared")
        );
        workspace.context_library[0].library_id = Some("nested".into());
        assert!(validate_workspace(&workspace).is_err());
        workspace.context_library[0].library_id = None;
        workspace.settings.suggestion_instructions = "x".repeat(8001);
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn linked_notes_persist_identity_without_duplicating_their_live_writing() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = example("My writing");
        workspace.notes[0]
            .sources
            .push(linked_source("linked-source", Some("reference-note")));
        persist_at_path(directory.path(), &workspace).unwrap();
        let saved = fs::read_to_string(paths(directory.path()).0).unwrap();
        assert!(!saved.contains("Derived writing must not be cached"));
        let restored = load_at_path(directory.path()).unwrap().0.unwrap();
        assert_eq!(
            restored.notes[0].sources[0].linked_note_id.as_deref(),
            Some("reference-note")
        );
        assert_eq!(restored.notes[0].sources[0].text, "");
        assert_eq!(
            workspace.notes[0].sources[0].text,
            "Derived writing must not be cached"
        );
    }

    #[test]
    fn linked_sources_require_valid_ids_and_allow_a_missing_target_for_recovery() {
        let mut workspace = example("My writing");
        workspace.notes[0]
            .sources
            .push(linked_source("linked-source", None));
        assert!(validate_workspace(&workspace).is_err());
        workspace.notes[0].sources[0].linked_note_id = Some("missing-note".into());
        assert!(validate_workspace(&workspace).is_ok());
        workspace.notes[0].sources[0].linked_note_id = Some("".into());
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn duplicate_links_and_link_ids_on_other_source_kinds_are_rejected() {
        let mut workspace = example("My writing");
        workspace.notes[0]
            .sources
            .push(linked_source("first-link", Some("target")));
        workspace.notes[0]
            .sources
            .push(linked_source("second-link", Some("target")));
        assert!(validate_workspace(&workspace).is_err());
        workspace.notes[0].sources.pop();
        workspace.notes[0].sources[0].kind = "markdown".into();
        assert!(validate_workspace(&workspace).is_err());
    }

    #[test]
    fn missing_palette_migrates_to_neutral_defaults_without_changing_the_existing_theme() {
        // example deliberately omits palette, as older notebooks do.
        let workspace = example("Draft");
        assert_eq!(workspace.settings.theme, "system");
        let palette = &workspace.settings.palette;
        assert_eq!(palette.light, "paper");
        assert_eq!(palette.dark, "graphite");
        assert_eq!(palette.custom_light.page, "#ffffff");
        assert_eq!(palette.custom_light.sidebar, "#f3f4f1");
        assert_eq!(palette.custom_light.accent, "#42644d");
        assert_eq!(palette.custom_dark.page, "#212121");
        assert_eq!(palette.custom_dark.sidebar, "#17191c");
        assert_eq!(palette.custom_dark.accent, "#a6b6c8");
        validate_workspace(&workspace).unwrap();
    }

    #[test]
    fn recovery_marker_is_load_metadata_and_never_enters_the_saved_schema() {
        let loaded = LoadedWorkspace {
            workspace: example("Recovered"),
            recovered: Some(true),
        };
        let response = serde_json::to_value(&loaded).unwrap();
        assert_eq!(response["version"], 1);
        assert_eq!(response["notes"][0]["content"], "Recovered");
        assert_eq!(response["recovered"], true);
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &loaded.workspace).unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(paths(directory.path()).0).unwrap()).unwrap();
        assert!(saved.get("recovered").is_none());
        let normal = LoadedWorkspace {
            workspace: example("Normal"),
            recovered: None,
        };
        assert!(serde_json::to_value(normal)
            .unwrap()
            .get("recovered")
            .is_none());
    }

    #[test]
    fn palette_colors_persist_but_malformed_values_cannot_replace_a_valid_notebook() {
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = example("Keep this draft");
        workspace.settings.palette.light = "custom".into();
        workspace.settings.palette.dark = "forest".into();
        workspace.settings.palette.custom_light.page = "#FAFAF8".into();
        persist_at_path(directory.path(), &workspace).unwrap();
        let restored = load_at_path(directory.path()).unwrap().0.unwrap();
        assert_eq!(restored.settings.palette.light, "custom");
        assert_eq!(restored.settings.palette.dark, "forest");
        assert_eq!(restored.settings.palette.custom_light.page, "#FAFAF8");
        let primary = paths(directory.path()).0;
        let original = fs::read(&primary).unwrap();
        for injected in [
            "#123",
            "#12345678",
            "#gg0000",
            "#fff; background:url(https://invalid.example)",
            "var(--injected)",
        ] {
            workspace.settings.palette.custom_dark.accent = injected.into();
            assert!(persist_at_path(directory.path(), &workspace).is_err());
            assert_eq!(fs::read(&primary).unwrap(), original);
        }
        workspace.settings.palette = Palette::default();
        workspace.settings.palette.dark = "url(https://invalid.example)".into();
        assert!(persist_at_path(directory.path(), &workspace).is_err());
        let mut raw = serde_json::to_value(example("Draft")).unwrap();
        raw["settings"]["palette"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Workspace>(raw).is_err());
    }

    #[test]
    fn write_failure_keeps_the_existing_primary_and_discards_only_its_temp_file() {
        let directory = tempfile::tempdir().unwrap();
        let primary = paths(directory.path()).0;
        persist_at_path(directory.path(), &example("Keep this draft")).unwrap();
        let result = atomic_write_with(&primary, |file| {
            file.write_all(b"{partial").unwrap();
            Err("Simulated disk full".into())
        });
        assert!(result.unwrap_err().contains("disk full"));
        assert_eq!(
            read_workspace(&primary).unwrap().notes[0].content,
            "Keep this draft"
        );
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn streaming_serialization_stops_at_the_size_bound_without_replacing_saved_data() {
        let directory = tempfile::tempdir().unwrap();
        let primary = paths(directory.path()).0;
        persist_at_path(directory.path(), &example("Keep this draft")).unwrap();
        let mut writer = BoundedWriter {
            inner: Vec::new(),
            remaining: 8,
        };
        writer.write_all(b"12345678").unwrap();
        assert!(writer.write_all(b"9").is_err());
        assert_eq!(writer.inner, b"12345678");
        // Every individual field is within its limit, but JSON escaping makes
        // the combined document exceed 64 MB. Its incomplete temp never commits.
        let mut oversized = example(&"\u{0000}".repeat(MAX_MARKDOWN_BYTES));
        oversized.notes[0].context = "\u{0000}".repeat(1024 * 1024);
        oversized.notes[0].sources.push(ContextSource {
            id: "source".into(),
            name: "Source".into(),
            kind: "text".into(),
            text: "\u{0000}".repeat(MAX_MARKDOWN_BYTES),
            origin: None,
            linked_note_id: None,
            library_id: None,
            folder: None,
            enabled: true,
            added_at: 1,
        });
        assert!(persist_at_path(directory.path(), &oversized)
            .unwrap_err()
            .contains("64 MB"));
        assert_eq!(
            read_workspace(&primary).unwrap().notes[0].content,
            "Keep this draft"
        );
    }

    #[test]
    fn multiple_recoveries_retain_every_corrupt_original_and_leave_bad_backups_untouched() {
        let directory = tempfile::tempdir().unwrap();
        persist_at_path(directory.path(), &example("Backup draft")).unwrap();
        persist_at_path(directory.path(), &example("Latest draft")).unwrap();
        let (primary, backup) = paths(directory.path());
        for corrupt in ["{first damaged original", "{second damaged original"] {
            fs::write(&primary, corrupt).unwrap();
            load_at_path(directory.path()).unwrap();
        }
        let mut archived: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("workspace-v1.corrupt-")
            })
            .map(|path| fs::read_to_string(path).unwrap())
            .collect();
        archived.sort();
        assert_eq!(
            archived,
            ["{first damaged original", "{second damaged original"]
        );
        fs::write(&primary, "bad primary").unwrap();
        fs::write(&backup, "bad backup").unwrap();
        assert!(load_at_path(directory.path()).is_err());
        assert_eq!(fs::read_to_string(&primary).unwrap(), "bad primary");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "bad backup");
    }

    #[test]
    fn incomplete_initial_save_is_reported_and_preserved_instead_of_opening_an_empty_notebook() {
        let directory = tempfile::tempdir().unwrap();
        let pending = directory.path().join(".workspace-v1.json.pending-test");
        fs::write(&pending, "{unfinished first draft").unwrap();
        assert!(load_at_path(directory.path())
            .unwrap_err()
            .contains("interrupted"));
        assert_eq!(
            fs::read_to_string(pending).unwrap(),
            "{unfinished first draft"
        );
        assert!(!paths(directory.path()).0.exists());
    }

    #[test]
    fn recovery_failure_leaves_the_previous_snapshot_and_the_problem_path_intact() {
        let directory = tempfile::tempdir().unwrap();
        let (primary, backup) = paths(directory.path());
        write_workspace(&backup, &example("Recoverable draft")).unwrap();
        fs::create_dir(&primary).unwrap();
        assert!(load_at_path(directory.path()).is_err());
        assert!(primary.is_dir());
        assert_eq!(
            read_workspace(&backup).unwrap().notes[0].content,
            "Recoverable draft"
        );
    }

    // Invoked only by interrupted_saves_keep_a_complete_primary_or_recovery_copy.
    #[test]
    #[ignore]
    fn interrupted_save_child() {
        let directory = PathBuf::from(std::env::var_os("TYPENEXT_TEST_SAVE_DIRECTORY").unwrap());
        persist_at_path(&directory, &example("Complete new draft")).unwrap();
        panic!("The parent must terminate the child at its checkpoint");
    }

    #[test]
    fn interrupted_saves_keep_a_complete_primary_or_recovery_copy() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        for filename in ["workspace-v1.backup.json", "workspace-v1.json"] {
            for phase in ["written", "synced", "replaced", "durable"] {
                let directory = tempfile::tempdir().unwrap();
                persist_at_path(directory.path(), &example("Complete older draft")).unwrap();
                persist_at_path(directory.path(), &example("Complete current draft")).unwrap();
                let marker = directory.path().join("crash-checkpoint.txt");
                let checkpoint = format!("{filename}:{phase}");
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "workspace::tests::interrupted_save_child",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("TYPENEXT_TEST_SAVE_DIRECTORY", directory.path())
                    .env("TYPENEXT_TEST_SAVE_CHECKPOINT", &checkpoint)
                    .env("TYPENEXT_TEST_SAVE_MARKER", &marker)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let started = Instant::now();
                while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
                    if child.try_wait().unwrap().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                let reached_checkpoint = marker.exists();
                let _ = child.kill(); // SIGKILL / TerminateProcess: no destructor cleanup.
                child.wait().unwrap();
                assert!(reached_checkpoint, "Child did not reach {checkpoint}");
                let (primary, backup) = paths(directory.path());
                let current = read_workspace(&primary).unwrap().notes[0].content.clone();
                let previous = read_workspace(&backup).unwrap().notes[0].content.clone();
                assert!(
                    matches!(
                        current.as_str(),
                        "Complete current draft" | "Complete new draft"
                    ),
                    "{checkpoint}: {current}"
                );
                assert!(
                    matches!(
                        previous.as_str(),
                        "Complete older draft" | "Complete current draft"
                    ),
                    "{checkpoint}: {previous}"
                );
                assert_eq!(
                    load_at_path(directory.path()).unwrap().0.unwrap().notes[0].content,
                    current
                );
                // A later unreadable primary always recovers a complete synced
                // backup, including when the process died during replacement.
                fs::write(primary, "{torn").unwrap();
                assert_eq!(
                    load_at_path(directory.path()).unwrap().0.unwrap().notes[0].content,
                    previous
                );
            }
        }
        // On a first-ever save there is no prior snapshot. A complete abandoned
        // sibling is recovered after an abrupt kill, while partial JSON is never
        // accepted by the recovery reader.
        for phase in ["written", "synced"] {
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("crash-checkpoint.txt");
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "workspace::tests::interrupted_save_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("TYPENEXT_TEST_SAVE_DIRECTORY", directory.path())
                .env(
                    "TYPENEXT_TEST_SAVE_CHECKPOINT",
                    format!("workspace-v1.json:{phase}"),
                )
                .env("TYPENEXT_TEST_SAVE_MARKER", &marker)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let started = Instant::now();
            while !marker.exists() && started.elapsed() < Duration::from_secs(10) {
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let reached_checkpoint = marker.exists();
            let _ = child.kill();
            child.wait().unwrap();
            assert!(reached_checkpoint);
            assert!(!paths(directory.path()).0.exists());
            let (recovered, used_recovery) = load_at_path(directory.path()).unwrap();
            assert!(used_recovery);
            assert_eq!(recovered.unwrap().notes[0].content, "Complete new draft");
        }
    }

    /// Opt-in diagnostic with isolated data; timing is reported, never asserted.
    #[test]
    #[ignore]
    fn measure_workspace_save_cost() {
        use std::hint::black_box;
        use std::time::Instant;
        let directory = tempfile::tempdir().unwrap();
        let mut workspace = example(&"A paragraph of the writer's own words.\n".repeat(28_000));
        workspace.notes[0].sources.push(ContextSource {
            id: "reference".into(),
            name: "Research".into(),
            kind: "text".into(),
            text: "Attached material for useful recall.\n".repeat(28_000),
            origin: None,
            linked_note_id: None,
            library_id: None,
            folder: None,
            enabled: true,
            added_at: 1,
        });
        persist_at_path(directory.path(), &workspace).unwrap();
        let primary = paths(directory.path()).0;
        let started = Instant::now();
        for _ in 0..10 {
            black_box(read_workspace(&primary).unwrap());
        }
        let bounded_read = started.elapsed();
        let started = Instant::now();
        for _ in 0..10 {
            let bytes = fs::read(&primary).unwrap();
            let workspace: Workspace = serde_json::from_slice(&bytes).unwrap();
            validate_workspace(&workspace).unwrap();
            black_box(workspace);
        }
        let buffered_read = started.elapsed();
        let started = Instant::now();
        for _ in 0..10 {
            persist_at_path(directory.path(), &workspace).unwrap();
        }
        println!("bytes={} bounded_read_avg_ms={:.2} previous_buffered_read_avg_ms={:.2} durable_save_avg_ms={:.2}",
            fs::metadata(primary).unwrap().len(), bounded_read.as_secs_f64() * 100.0,
            buffered_read.as_secs_f64() * 100.0, started.elapsed().as_secs_f64() * 100.0);
    }
}
